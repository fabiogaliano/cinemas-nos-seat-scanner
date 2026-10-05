/**
 * Keeps a set of seats reserved overnight after a payment falls through, and
 * hands them over on command.
 *
 * How it works, and why it works at all — all measured against the live site:
 *
 *   - Advancing past the seat map reserves the seats server-side. An unrelated
 *     visitor reads them as busy from that moment.
 *   - Left alone, the reservation lasts 300s from the Ticket screen loading.
 *     Advancing a step does not buy more time.
 *   - When that countdown fires the app navigates to Page_PurchaseOutOfTime and
 *     the seats are released within ~8s.
 *   - Going through to paygate is the exception: a pending MB WAY payment holds
 *     the seats well past the 300s window, and past the MB WAY countdown too.
 *     That is why the loop tolerates a long opening lockout but expects the
 *     steady-state gap to be seconds.
 *
 * So a cycle is: take the seats, sit on them for the full window, let NOS
 * release them, take them again — repeatedly, until told to buy or to stop.
 * The gap between cycles is seconds, which is the smallest window anyone else
 * gets to take them.
 *
 * Nothing here presses "Pagar agora" on its own. A payment happens only when a
 * command says so.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  advance, DATA_DIR, isTimedOut, observePayment, openCheckout, payFromCheckout, readSelection,
  readShowing, selectSeats, whereAmI, type Buyer,
} from "./checkout";
import { commandButtons, controlTopicFor, readCommand } from "./control";
import { notifyText, notifyWithImage } from "./notify";
import { allSeatsAreFree, describeSeats, resolveAllCols, type SeatTarget } from "./seats";

const STATE_FILE = join(DATA_DIR, "retention-state.json");

/**
 * Stay on the page until the countdown actually fires.
 *
 * The countdown is client-side: close the browser early and CountdownFinished
 * never runs, so NOS never navigates to Page_PurchaseOutOfTime and never
 * explicitly drops the booking. The ~8s release was measured with the page
 * open, and that prompt release is the whole reason the gap between cycles is
 * seconds. This caps how long to wait for it before giving up on the page.
 */
const EXPIRY_OVERSHOOT_MS = 90_000;
/** How often to check the phone for a command while holding. */
const COMMAND_POLL_MS = 5_000;
/**
 * A payment run needs roughly a minute of checkout left. A "go" arriving later
 * than that in the window is honoured on the next cycle's fresh booking rather
 * than started against a booking about to expire mid-form.
 */
const PAY_NEEDS_MS = 90_000;

/**
 * Whether a failed acquisition is expected, and whether to give up.
 *
 * Extracted and tested because getting it wrong is what lost a real set of
 * seats: misses accumulated during the lockout, so the counter was already past
 * the threshold the moment the lockout ended and retention quit on its first
 * genuine attempt. Misses while locked out must not count at all.
 */
export function assessMiss(input: {
  now: number;
  lockoutUntil: number;
  misses: number;
  lostAfter: number;
}): { lockedOut: boolean; misses: number; giveUp: boolean } {
  const lockedOut = input.now < input.lockoutUntil;
  const misses = lockedOut ? 0 : input.misses + 1;
  return { lockedOut, misses, giveUp: !lockedOut && misses >= input.lostAfter };
}

export type RetentionStatus = "holding" | "paying" | "bought" | "stopped" | "lost" | "deadline";

export type RetentionState = {
  sessionUuid: string;
  ticketCount: number;
  /** Every group taken; more than one when the party could not sit together. */
  seats: SeatTarget[];
  /** Scopes the buttons to this run, so an old notification cannot drive it. */
  nonce: string;
  status: RetentionStatus;
  cycles: number;
  updatedAt: string;
};

export type RetentionOutcome = {
  status: RetentionStatus;
  cycles: number;
  reason: string;
};

export async function readRetentionState(): Promise<RetentionState | null> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as RetentionState;
    return parsed?.sessionUuid ? parsed : null;
  } catch {
    // Absent or truncated — there is simply nothing to resume.
    return null;
  }
}

async function writeRetentionState(state: RetentionState) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STATE_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, STATE_FILE);
}

export async function clearRetentionState() {
  await writeFile(STATE_FILE, JSON.stringify({ cleared: new Date().toISOString() }, null, 2)).catch(() => {});
}

type Held = Awaited<ReturnType<typeof openCheckout>>;

/**
 * Take the exact seats and commit them. Returns null when they are not
 * available — never a substitute, because tickets are not refundable and
 * quietly holding the wrong seats would be worse than holding none.
 */
async function acquire(browser: Browser, options: {
  sessionUuid: string;
  ticketCount: number;
  seats: SeatTarget[];
}): Promise<{ held: Held; label: string } | null> {
  const checkout = await openCheckout(browser, options.sessionUuid, {
    ticketCount: options.ticketCount, tag: "hold",
  });
  let ok = false;
  try {
    if (!allSeatsAreFree(checkout.rows, options.seats)) return null;
    const resolved = resolveAllCols(checkout.rows, options.seats);
    if (!resolved) return null;

    const picked = await selectSeats(checkout.page, checkout.rows, resolved);
    if (!picked.ok) return null;
    await checkout.page.waitForTimeout(3000);
    const label = await readSelection(checkout.page);

    // Advancing past the seat map is what actually reserves them; selecting
    // alone does not survive a second visitor's read.
    const screen = await whereAmI(checkout.page);
    if (screen !== "seats") return null;
    await advance(checkout.page, "seats");

    ok = true;
    return { held: checkout, label };
  } finally {
    if (!ok) await checkout.context.close().catch(() => {});
  }
}

export async function retain(options: {
  sessionUuid: string;
  ticketCount: number;
  seats: SeatTarget[];
  buyer: Buyer;
  notifyTopic: string;
  /** Give up at this instant (ms since epoch). */
  until: number;
  headless?: boolean;
  /** Wait between attempts when the seats are not free. */
  recheckMs?: number;
  /** Consecutive failed acquisitions before declaring the seats lost. */
  lostAfter?: number;
  /**
   * How long to keep retrying at the start without concluding the seats are
   * gone.
   *
   * A pending MB WAY payment holds the seats far longer than anything else in
   * this flow. Measured end to end: seats taken at checkout, push sent 80s
   * later, left unapproved — they came back **20m 35s after the Ticket screen
   * loaded**, which is 19m after the push and 13m after MB WAY's own countdown
   * had already expired. So the first re-acquisition is expected to miss for a
   * long time, and treating that as "lost" would abandon seats that are merely
   * still ours. 25 minutes leaves real margin over the measured 20.
   */
  initialLockoutMs?: number;
  /**
   * How long to watch the paygate after a push before deciding it was not
   * approved. MB WAY's own countdown is just under six minutes.
   */
  payObserveMs?: number;
  nonce?: string;
}): Promise<RetentionOutcome> {
  const {
    sessionUuid, ticketCount, seats, buyer, notifyTopic, until,
    headless = true, recheckMs = 30_000, lostAfter = 5, initialLockoutMs = 25 * 60_000,
    payObserveMs = 8 * 60_000, nonce = crypto.randomUUID().slice(0, 8),
  } = options;
  /**
   * Until when a failed acquisition is expected rather than alarming. Armed at
   * the start (the payment that sent us here still holds the seats) and re-armed
   * after every unapproved push, which locks them again for ~20 minutes.
   */
  let lockoutUntil = Date.now() + initialLockoutMs;

  const controlTopic = controlTopicFor(notifyTopic);
  // Only taps from now on count: the topic may hold older presses, including
  // ones aimed at a previous run.
  let commandCursor = Math.floor(Date.now() / 1000);
  let cycles = 0;
  let misses = 0;
  let announced = false;

  const browser = await chromium.launch({
    headless, args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const save = (status: RetentionStatus) => writeRetentionState({
    sessionUuid, ticketCount, seats, nonce, status, cycles, updatedAt: new Date().toISOString(),
  }).catch(() => {});
  const done = async (status: RetentionStatus, reason: string): Promise<RetentionOutcome> => {
    await save(status);
    return { status, cycles, reason };
  };

  try {
    // Say something up front: after a failed payment the seats stay locked for
    // many minutes, and silence through that is indistinguishable from a
    // watcher that died.
    await notifyText({
      topic: notifyTopic,
      title: "A recuperar os lugares",
      message: `${describeSeats(seats)}. Aviso-te assim que estiverem seguros.`,
      priority: "default",
    }).catch(() => undefined);

    while (Date.now() < until) {
      const got = await acquire(browser, { sessionUuid, ticketCount, seats }).catch((error: Error) => {
        console.warn(`  · acquisition failed: ${error.message}`);
        return null;
      });

      if (!got) {
        // Right after our own release the seats read busy for a few seconds, so
        // a single miss means nothing; a run of them means someone else has them
        // — except during the opening lockout, when they are still held by the
        // payment attempt that sent us here.
        const assessed = assessMiss({ now: Date.now(), lockoutUntil, misses, lostAfter });
        const lockedOut = assessed.lockedOut;
        misses = assessed.misses;
        // Misses while locked out are expected and must not count: letting them
        // accumulate meant the counter was already far past `lostAfter` the
        // moment the lockout ended, so retention declared the seats lost on its
        // first real attempt instead of trying. Observed in production: 35
        // lockout misses, then "lost after 0 cycles" one attempt later.
        if (assessed.giveUp) {
          await notifyText({
            topic: notifyTopic,
            title: "Lugares perdidos",
            // Indistinguishable from here: a payment that went through also
            // leaves the seats permanently busy. Say so rather than assert the
            // worse reading.
            message: `${describeSeats(seats)} deixaram de estar livres. Ou alguem os levou, ou o pagamento passou - confirma o email.`,
            priority: "urgent",
          }).catch(() => undefined);
          return done("lost", `seats unavailable ${misses} times running`);
        }
        console.log(lockedOut
          ? `  · seats still locked by the previous attempt (${misses}); waiting`
          : `  · seats not free (miss ${misses}/${lostAfter}); retrying in ${Math.round(recheckMs / 1000)}s`);

        // Keep listening while waiting: the lockout can run for many minutes,
        // and a "Parar" that goes unheard until it ends is a dead button.
        const waitUntil = Date.now() + recheckMs;
        while (Date.now() < waitUntil) {
          await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_MS));
          const waiting = await readCommand({ controlTopic, nonce, sinceSeconds: commandCursor }).catch(() => null);
          if (waiting?.command === "stop") {
            commandCursor = waiting.atSeconds;
            await notifyText({
              topic: notifyTopic, title: "Retencao terminada",
              message: "Deixei de tentar recuperar os lugares. Nada foi comprado.", priority: "default",
            }).catch(() => undefined);
            return done("stopped", "stop command received while waiting for the seats");
          }
          // A "go" is left on the topic deliberately: there is no booking to pay
          // for yet, so the next successful hold picks it up.
        }
        continue;
      }

      misses = 0;
      cycles++;
      const { held, label } = got;
      await save("holding");
      console.log(`  · cycle ${cycles}: holding ${label || describeSeats(seats)} until ${new Date(held.expiresAt).toISOString().slice(11, 19)}Z`);

      if (!announced) {
        announced = true;
        const info = await readShowing(held.page).catch(() => ({ title: "Filme", when: "", cinema: "" }));
        const shot = join(DATA_DIR, "held-seats.png");
        await held.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const message = `${info.when} · ${info.cinema} · ${ticketCount} bilhetes\nLugares ${label || describeSeats(seats)} reservados. Toca "Comprar agora" para pagar por MB WAY.`;
        const sent = await notifyWithImage({
          topic: notifyTopic,
          imagePath: shot,
          title: `${info.title} — lugares seguros`,
          message,
          priority: "urgent",
          tags: ["lock"],
          actions: commandButtons(controlTopic, nonce),
        }).catch((error: Error) => ({ sent: false, reason: error.message }));
        console.log(`  · ntfy: ${sent.sent ? "hold alert sent" : sent.reason}`);
      }

      // Sit on the page until NOS itself times it out: that navigation is what
      // releases the seats promptly, and closing early forfeits it.
      const holdUntil = Math.min(held.expiresAt + EXPIRY_OVERSHOOT_MS, until);
      let command: Awaited<ReturnType<typeof readCommand>> = null;
      let timedOut = false;
      while (Date.now() < holdUntil) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_MS));
        if (isTimedOut(held.page)) { timedOut = true; break; }
        const seen = await readCommand({ controlTopic, nonce, sinceSeconds: commandCursor })
          .catch(() => null);
        if (!seen) continue;
        // Too late in the window to start a payment: leave the tap on the topic
        // and honour it against the next cycle's fresh 5 minutes.
        if (seen.command === "go" && held.expiresAt - Date.now() < PAY_NEEDS_MS) {
          console.log("  · buy command arrived too late in this window; will pay on the next hold");
          continue;
        }
        command = seen;
        break;
      }
      if (timedOut) console.log("  · window expired; NOS released the seats");

      if (command) {
        // Advance the cursor first: taps arrive duplicated, and a command that
        // has been acted on must never fire a second push.
        commandCursor = command.atSeconds;
        if (command.command === "stop") {
          await held.context.close().catch(() => {});
          await notifyText({
            topic: notifyTopic, title: "Retenção terminada",
            message: "Deixei de segurar os lugares. Nada foi comprado.", priority: "default",
          }).catch(() => undefined);
          return done("stopped", "stop command received");
        }

        await save("paying");
        // Confirm immediately: an ntfy http action gives no feedback of its
        // own, so without this the tap feels like it did nothing.
        await notifyText({
          topic: notifyTopic, title: "A pagar agora",
          message: "Recebi a ordem. Vou pedir o pagamento MB WAY — aprova o push no telemóvel.",
          priority: "high",
        }).catch(() => undefined);

        try {
          const paid = await payFromCheckout(held.page, {
            buyer, mode: "buy", step: (name) => console.log(`  → ${name}`),
          });
          await notifyText({
            topic: notifyTopic, title: "Push MB WAY enviado",
            message: `${paid.total} — aprova na app MB WAY dentro de 5 minutos, senao e cancelado.`,
            priority: "urgent",
          }).catch(() => undefined);

          // Sending a push is not buying. Retention used to return here with
          // status "bought", which stopped the holding — so a push nobody
          // approved left the seats unprotected and unannounced. Wait for the
          // real outcome instead, and only stop when the money actually moved.
          const watched = await observePayment(held.page, {
            timeoutMs: payObserveMs, step: (name) => console.log(`  → ${name}`),
          });
          await held.context.close().catch(() => {});
          console.log(`  · payment outcome: ${watched.outcome}`);

          if (watched.outcome === "approved") {
            await notifyText({
              topic: notifyTopic, title: "Bilhetes comprados",
              message: `${paid.total} — pagamento aprovado. ${describeSeats(seats)}. Verifica o email.`,
              priority: "urgent",
            }).catch(() => undefined);
            return done("bought", `payment approved for ${paid.total}`);
          }

          // Not approved — or unrecognised wording, which is treated the same
          // because assuming success would drop seats we still need. The
          // payment attempt holds them for ~20 minutes, so re-arm the lockout
          // before going back to acquiring.
          await notifyText({
            topic: notifyTopic,
            title: watched.outcome === "dead" ? "Push expirou" : "Pagamento por confirmar",
            message: `Nao foi aprovado a tempo. Continuo a segurar ${describeSeats(seats)} — toca "Comprar agora" outra vez quando puderes.`,
            priority: "high",
          }).catch(() => undefined);
          lockoutUntil = Date.now() + initialLockoutMs;
          continue;
        } catch (error) {
          // The seats are still ours until the window runs out, so a failed
          // payment attempt falls back into holding rather than giving up.
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`  · payment attempt failed: ${reason}`);
          await notifyText({
            topic: notifyTopic, title: "Pagamento falhou",
            message: `${reason}. Continuo a segurar os lugares.`, priority: "high",
          }).catch(() => undefined);
        }
      }

      await held.context.close().catch(() => {});
      // NOS releases within ~8s of the countdown firing; a short pause avoids
      // racing our own release and reading the seats as still busy.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }

    await notifyText({
      topic: notifyTopic, title: "Retencao expirou",
      message: `Deixei de segurar ${describeSeats(seats)} apos ${cycles} ciclos. Nada foi comprado.`,
      priority: "urgent",
    }).catch(() => undefined);
    return done("deadline", "reached the retention deadline");
  } finally {
    await browser.close().catch(() => {});
  }
}
