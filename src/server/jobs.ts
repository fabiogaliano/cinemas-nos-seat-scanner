import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanJob, ScanRequest } from "../shared/types";
import { scan } from "./scanner";

const dataDir = process.env.CINEMAS_DATA_DIR ?? join(import.meta.dir, "../../data");
const jobs = new Map<string, ScanJob>();
const controllers = new Map<string, AbortController>();
const writeQueues = new Map<string, Promise<void>>();
const waiters = new Map<string, Set<(job: ScanJob) => void>>();
let queue = Promise.resolve();

async function persist(job: ScanJob) {
  const snapshot = JSON.stringify(job);
  const previous = writeQueues.get(job.id) ?? Promise.resolve();
  const current = previous.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const target = join(dataDir, `${job.id}.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, target);
  });
  writeQueues.set(job.id, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(job.id) === current) writeQueues.delete(job.id);
  }
}

function persistLater(job: ScanJob) {
  void persist(job).catch((error) => console.error("Could not persist scan", error));
}

function changed(job: ScanJob) {
  job.revision += 1;
  const pending = waiters.get(job.id);
  if (!pending) return;
  waiters.delete(job.id);
  for (const resolve of pending) resolve(job);
}

export function waitForJob(id: string, after: number, signal: AbortSignal) {
  const job = jobs.get(id);
  if (signal.aborted) return Promise.resolve(undefined);
  if (!job || job.revision > after || ["complete", "failed", "cancelled"].includes(job.status)) return Promise.resolve(job);
  return new Promise<ScanJob | undefined>((resolve) => {
    const pending = waiters.get(id) ?? new Set();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (next: ScanJob | undefined) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      pending.delete(finish);
      if (pending.size === 0) waiters.delete(id);
      resolve(next);
    };
    const aborted = () => finish(undefined);
    timer = setTimeout(() => finish(jobs.get(id)), 15_000);
    pending.add(finish);
    waiters.set(id, pending);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function loadJobs() {
  await mkdir(dataDir, { recursive: true });
  const legacyJobs = (await readdir(dataDir)).filter((file) => /^[a-f0-9-]{36}\.json$/i.test(file));
  await Promise.all(legacyJobs.map((file) => unlink(join(dataDir, file)).catch(() => undefined)));
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function createJob(request: ScanRequest) {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job: ScanJob = {
    id,
    status: "queued",
    movieTitle: request.movieTitle,
    request,
    sessions: [],
    total: 0,
    scanned: 0,
    failures: [],
    createdAt: new Date().toISOString(),
    revision: 0,
  };
  jobs.set(id, job);
  controllers.set(id, controller);
  persistLater(job);

  queue = queue.then(async () => {
    if (controller.signal.aborted) return;
    job.status = "discovering";
    changed(job);
    persistLater(job);
    try {
      await scan(request, {
        signal: controller.signal,
        onDiscovered(movieTitle, total) {
          job.movieTitle = movieTitle;
          job.total = total;
          job.status = "scanning";
          changed(job);
          persistLater(job);
        },
        onSession(session, index, total) {
          job.sessions.push(session);
          job.scanned = index;
          job.total = total;
          job.currentLabel = session.label;
          changed(job);
          persistLater(job);
        },
        onSessionError(session, index, total, error) {
          job.scanned = index;
          job.total = total;
          job.currentLabel = session.label;
          job.failures?.push({ label: session.label, error: error.message });
          changed(job);
          persistLater(job);
        },
      });
      job.status = "complete";
      job.currentLabel = undefined;
      changed(job);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        job.status = "cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "O scan falhou.";
      }
      changed(job);
    } finally {
      controllers.delete(id);
      await unlink(join(dataDir, `${job.id}.json`)).catch(() => undefined);
    }
  });

  return job;
}

export function cancelJob(id: string) {
  const job = jobs.get(id);
  const controller = controllers.get(id);
  if (!job || !controller) return false;
  controller.abort();
  job.status = "cancelled";
  changed(job);
  persistLater(job);
  return true;
}
