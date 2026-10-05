/**
 * Hold seats until told to buy them.
 *
 *   bun scripts/hold.ts <sessionUuid> --row 4 --seats 6,7,8,9
 *   bun scripts/hold.ts --resume            # continue what the last run was holding
 *
 * Re-takes the seats every 5 minutes and waits for the "Comprar agora" button
 * on the ntfy alert. Buys nothing on its own.
 */
import { retain, readRetentionState } from "../src/retention";
import { buyer, notify, retentionDeadline } from "../src/config";
import { describeSeats } from "../src/seats";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : undefined;
};

const notifyTopic = notify.topic;
if (!notifyTopic) throw new Error("NTFY_TOPIC is empty — there would be no way to tell it to buy.");

const resumed = argv.includes("--resume") ? await readRetentionState() : null;
if (argv.includes("--resume") && !resumed) throw new Error("Não há nada para retomar em retention-state.json.");

const sessionUuid = resumed?.sessionUuid ?? argv[0];
// Resuming restores every group, so a party that had to be split across rows
// comes back whole rather than half-protected.
const seats = resumed
  ? resumed.seats
  : [{
      row: Number(flag("row")),
      nums: (flag("seats") ?? "").split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n)),
    }];
const ticketCount = resumed?.ticketCount ?? seats.reduce((total, g) => total + g.nums.length, 0);

if (!sessionUuid || seats.some((g) => !Number.isInteger(g.row) || g.nums.length === 0)) {
  throw new Error("usage: bun scripts/hold.ts <sessionUuid> --row <n> --seats <n,n,...>");
}

/**
 * When to give up. `--until HH:MM` still works for a deliberate short run;
 * without it the default is a duration from now, so the protection does not
 * depend on what time of day the hold happens to start.
 */
function deadlineFrom(value: string | undefined) {
  if (!value) return new Date(retentionDeadline());
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) throw new Error(`--until inválido: "${value}"`);
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at;
}

const until = deadlineFrom(flag("until"));
console.log(
  `holding ${describeSeats(seats)} · ${ticketCount} bilhetes · session ${sessionUuid.slice(0, 8)}${resumed ? " (resumed)" : ""}\n` +
  `until ${until.toLocaleString("pt-PT")} · tap "Comprar agora" on the ntfy alert to pay`,
);

const outcome = await retain({
  sessionUuid,
  ticketCount,
  seats,
  buyer,
  notifyTopic,
  until: until.getTime(),
  headless: !argv.includes("--headed"),
  nonce: resumed?.nonce,
});

console.log("\n--- outcome ---");
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.status === "bought" ? 0 : 1);
