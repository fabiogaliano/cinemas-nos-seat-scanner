import { readFile } from "node:fs/promises";

const NTFY_BASE = process.env.NTFY_BASE ?? "https://ntfy.sh";

// HTTP headers must be latin-1; film titles and the "•" seat separator both
// fall outside it, so flatten to plain ASCII rather than lose the send.
const ascii = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[•·]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

export async function notifyText(options: {
  topic: string;
  title: string;
  message: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  /** Prebuilt ntfy Actions header, e.g. from control.ts's buttons(). */
  actions?: string;
}) {
  const { topic, title, message, priority = "high", actions = "" } = options;
  if (!topic) return { sent: false, reason: "NTFY_TOPIC not set" };
  const response = await fetch(`${NTFY_BASE}/${topic}`, {
    method: "POST",
    headers: {
      Title: ascii(title),
      Priority: priority,
      Tags: "warning",
      ...(actions ? { Actions: actions } : {}),
    },
    body: ascii(message),
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok
    ? { sent: true, reason: "" }
    : { sent: false, reason: `ntfy ${response.status}` };
}

/**
 * ntfy treats a PUT body as the attachment, so the screenshot travels as the
 * message itself rather than needing to be hosted somewhere first.
 */
export async function notifyWithImage(options: {
  topic: string;
  imagePath: string;
  title: string;
  message: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  tags?: string[];
  /** Prebuilt ntfy Actions header, e.g. from control.ts's buttons(). */
  actions?: string;
}) {
  const { topic, imagePath, title, message, priority = "high", tags = ["movie_camera"], actions = "" } = options;
  if (!topic) return { sent: false, reason: "NTFY_TOPIC not set" };

  const body = await readFile(imagePath);
  const response = await fetch(`${NTFY_BASE}/${topic}`, {
    method: "PUT",
    headers: {
      Filename: "seats.png",
      Title: ascii(title),
      Message: ascii(message),
      Priority: priority,
      Tags: tags.join(","),
      ...(actions ? { Actions: actions } : {}),
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return { sent: false, reason: `ntfy ${response.status} ${await response.text()}` };
  return { sent: true, reason: "" };
}
