/**
 * The phone-to-loop command channel.
 *
 * The container serves no HTTP, so instead of an inbound endpoint the alert
 * carries ntfy action buttons that POST to a second topic, and the loop polls
 * that topic. No port to expose, no callback URL to secure.
 *
 * Commands are scoped by a per-run nonce so a button left sitting in an old
 * notification cannot drive a later run.
 */
export type HoldCommand = "go" | "stop";

const NTFY_BASE = process.env.NTFY_BASE ?? "https://ntfy.sh";

/** Where taps land. Kept off the alert topic so a tap does not notify you back. */
export function controlTopicFor(topic: string) {
  return `${topic}-control`;
}

/**
 * ntfy Actions header for the two buttons on the hold alert.
 *
 * `clear=true` dismisses the notification once the request goes out — an http
 * action gives no other feedback, so without it a tap feels like nothing
 * happened. The loop also replies on the alert topic when it accepts a command,
 * which is the confirmation you actually see.
 */
export function commandButtons(controlTopic: string, nonce: string) {
  const post = (label: string, body: string) =>
    `http, ${label}, ${NTFY_BASE}/${controlTopic}, method=POST, body=${body}-${nonce}, clear=true`;
  return `${post("Comprar agora", "go")}; ${post("Parar", "stop")}`;
}

type NtfyMessage = { message?: unknown; time?: unknown };

/**
 * The newest command since `sinceSeconds`, or null.
 *
 * Newest-wins rather than first-match, because taps arrive duplicated — a
 * single press can deliver three copies, and pressing both buttons is normal.
 * Acting on the first match would fire a push per duplicate; the caller
 * advances its cursor past `atSeconds` so an acted-on command cannot re-fire.
 */
export async function readCommand(options: {
  controlTopic: string;
  nonce: string;
  /** Unix seconds. Only messages strictly newer than this are considered. */
  sinceSeconds: number;
}): Promise<{ command: HoldCommand; atSeconds: number } | null> {
  const { controlTopic, nonce, sinceSeconds } = options;
  const response = await fetch(`${NTFY_BASE}/${controlTopic}/json?poll=1&since=${sinceSeconds}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ntfy ${response.status}`);

  const found: Array<{ command: HoldCommand; atSeconds: number }> = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    let parsed: NtfyMessage;
    try {
      parsed = JSON.parse(line) as NtfyMessage;
    } catch {
      continue; // ntfy interleaves keepalive/open events; ignore anything unparseable.
    }
    const body = typeof parsed.message === "string" ? parsed.message.trim() : "";
    const at = typeof parsed.time === "number" ? parsed.time : 0;
    if (at <= sinceSeconds) continue;
    if (body === `go-${nonce}`) found.push({ command: "go", atSeconds: at });
    if (body === `stop-${nonce}`) found.push({ command: "stop", atSeconds: at });
  }
  if (found.length === 0) return null;

  // Newest first; on an identical timestamp prefer "stop", the safe reading of
  // a phone that received both.
  found.sort((a, b) => b.atSeconds - a.atSeconds || (a.command === "stop" ? -1 : 1));
  return found[0];
}
