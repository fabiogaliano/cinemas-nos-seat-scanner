import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  DATA_DIR, observePayment, payFromCheckout, openCheckout, readSelection, readShowing, selectSeats,
  type Buyer, type PaymentOutcome,
} from "./checkout";
import { notifyWithImage } from "./notify";
import { allSeatsAreFree, describeSeats, resolveAllCols, type SeatTarget } from "./seats";
import { describePlan, planSeats, type SeatGroup } from "./seat-plan";

export { resolveCols, seatsAreFree, type SeatTarget } from "./seats";

export type PurchaseMode = "hold" | "buy";
export type PurchaseResult = {
  mode: PurchaseMode;
  /** Every group taken, so a split party can be re-acquired in full. */
  wanted: SeatTarget[] | null;
  selectedLabel: string;
  matched: boolean;
  total: string;
  pushSent: boolean;
  /** Only set when the run waited to see what became of the push. */
  outcome?: PaymentOutcome;
};

export async function purchase(
  sessionUuid: string,
  options: {
    ticketCount: number;
    mode: PurchaseMode;
    buyer: Buyer;
    headless?: boolean;
    slowMo?: number;
    /**
     * 0 disables stranger avoidance — pointless for films that sell out anyway.
     * Undefined falls through to the ranking's own default penalty.
     */
    strangerPenalty?: number;
    /** ntfy topic to send the seat screenshot to; skipped when empty. */
    notifyTopic?: string;
    notifyPriority?: "min" | "low" | "default" | "high" | "urgent";
    /**
     * Take exactly these seats instead of the ranked best block, and fail if
     * they cannot be had. Used when re-acquiring seats we already chose: a
     * substitute would silently buy the wrong seats, and tickets are not
     * refundable.
     */
    seats?: SeatTarget | SeatTarget[];
    /**
     * Stay on the paygate this long after the push to learn what became of it.
     * 0 keeps the old behaviour of returning as soon as the push is away.
     */
    observeMs?: number;
  },
): Promise<PurchaseResult> {
  const {
    ticketCount, mode, buyer, headless = true, slowMo = 0,
    strangerPenalty, notifyTopic = "", notifyPriority = "urgent", seats,
    observeMs = 0,
  } = options;
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      headless,
      slowMo,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const step = (name: string) => console.log(`  → ${name}`);
    step(`opening session ${sessionUuid.slice(0, 8)}`);

    const checkout = await openCheckout(browser, sessionUuid, { ticketCount, tag: "buy" });
    const { page, rows } = checkout;
    await page.waitForTimeout(2500);

    // An explicit target must be honoured exactly. Otherwise the ranking picks:
    // one contiguous block when the room allows, and its own best split when it
    // does not — never NOS's auto-pick, which nobody chose and nobody sees.
    let groups: SeatGroup[] = [];
    let split = false;
    if (seats) {
      const requested = Array.isArray(seats) ? seats : [seats];
      const resolved = resolveAllCols(rows, requested);
      if (!resolved) throw new Error(`Os lugares ${describeSeats(requested)} não existem neste mapa.`);
      if (!allSeatsAreFree(rows, requested)) throw new Error(`Os lugares ${describeSeats(requested)} já não estão livres.`);
      groups = resolved.map((entry, index) => ({ ...entry, nums: requested[index].nums }));
      split = groups.length > 1;
    } else {
      const plan = planSeats(rows, ticketCount, { strangerPenalty });
      if (plan) ({ groups, split } = plan);
    }

    let matched = false;
    if (groups.length) {
      const picked = await selectSeats(page, rows, groups.map((g) => ({ row: g.row, cols: g.cols })));
      console.log(`  · targeting ${describePlan(groups)}${split ? " (SPLIT — no single run was long enough)" : ""} → ok=${picked.ok} chosen=${picked.chosen}${picked.reason ? ` (${picked.reason})` : ""}`);
      if (!picked.ok) {
        if (seats) throw new Error(`Não consegui reservar ${describePlan(groups)}: ${picked.reason}`);
        console.warn("Seat targeting failed; fell back to free seats.");
      } else matched = true;
    } else {
      console.warn("A sala não tem lugares suficientes para o grupo; seguem os lugares que a NOS escolheu.");
    }
    // OutSystems re-renders the summary asynchronously after each seat click.
    await page.waitForTimeout(3000);
    const selectedLabel = await readSelection(page);
    // The seat page carries film, format, date, cinema and seats in one view,
    // which is exactly what needs checking before money moves.
    const shotPath = join(DATA_DIR, "chosen-seats.png");
    await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    if (notifyTopic) {
      const info = await readShowing(page);
      const sent = await notifyWithImage({
        topic: notifyTopic,
        imagePath: shotPath,
        title: `${info.title} — ${selectedLabel || "lugares"}`,
        message: `${info.when} · ${info.cinema} · ${ticketCount} bilhetes`,
        // Urgent breaks through Do Not Disturb: the whole point is to be
        // wakeable when a date opens overnight.
        priority: notifyPriority,
      }).catch((error: Error) => ({ sent: false, reason: error.message }));
      step(`ntfy: ${sent.sent ? `sent to ${notifyTopic}` : sent.reason}`);
    }
    // Positional mapping is an assumption; NOS printing back the seats we asked
    // for is the only proof it held. The label is empty on a single-ticket
    // purchase, so treat it as a cross-check of the click, not the proof.
    if (matched && groups.length && selectedLabel) {
      const allNums = groups.flatMap((g) => g.nums);
      // Exact numbers, not substrings: wanted seat 6 must not be "confirmed" by
      // a label reading M16, which is exactly what an off-by-N mapping shows.
      const labelNums = (selectedLabel.match(/\d+/g) ?? []).map(Number);
      matched = allNums.every((num) => labelNums.includes(num));
      if (!matched) {
        const complaint = `Selection mismatch: wanted ${describePlan(groups)}, page shows "${selectedLabel}".`;
        if (seats) throw new Error(complaint);
        console.warn(complaint);
      }
    }

    step(`seats: ${selectedLabel || "(label unread)"}${groups.length ? ` (wanted ${describePlan(groups)})` : ""}`);
    const { total, pushSent } = await payFromCheckout(page, { buyer, mode, step });

    // Waiting out the push is what turns "we asked for money" into "we know
    // whether it arrived", which is what decides between done and retention.
    let outcome: PaymentOutcome | undefined;
    if (pushSent && observeMs > 0) {
      step(`watching the payment for up to ${Math.round(observeMs / 60_000)} min`);
      const watched = await observePayment(page, { timeoutMs: observeMs, step });
      outcome = watched.outcome;
      // Log the wording, not just the verdict: the terminal strings are the one
      // part of this flow that cannot be learned without a real payment, so
      // every run that reaches one is a chance to record it.
      step(`payment outcome: ${outcome} — paygate said: ${watched.text.slice(0, 200)}`);
    }

    // Headed runs are for watching; give the window time to be read.
    if (!headless) await page.waitForTimeout(20_000);

    return {
      mode,
      wanted: groups.length ? groups.map((g) => ({ row: g.row, nums: g.nums })) : null,
      selectedLabel,
      matched,
      total,
      pushSent,
      outcome,
    };
  } finally {
    await browser?.close();
  }
}
