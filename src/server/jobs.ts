import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanJob, ScanRequest } from "../shared/types";
import { scan } from "./scanner";

const dataDir = process.env.CINEMAS_DATA_DIR ?? join(import.meta.dir, "../../data");
const jobs = new Map<string, ScanJob>();
const controllers = new Map<string, AbortController>();
const writeQueues = new Map<string, Promise<void>>();
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
    movieTitle: "A preparar…",
    request,
    sessions: [],
    total: 0,
    scanned: 0,
    failures: [],
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  controllers.set(id, controller);
  persistLater(job);

  queue = queue.then(async () => {
    if (controller.signal.aborted) return;
    job.status = "discovering";
    await persist(job);
    try {
      await scan(request, {
        signal: controller.signal,
        onDiscovered(movieTitle, total) {
          job.movieTitle = movieTitle;
          job.total = total;
          job.status = "scanning";
          persistLater(job);
        },
        onSession(session, index, total) {
          job.sessions.push(session);
          job.scanned = index;
          job.total = total;
          job.currentLabel = session.label;
          persistLater(job);
        },
        onSessionError(session, index, total, error) {
          job.scanned = index;
          job.total = total;
          job.currentLabel = session.label;
          job.failures?.push({ label: session.label, error: error.message });
          persistLater(job);
        },
      });
      job.status = "complete";
      job.currentLabel = undefined;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        job.status = "cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "O scan falhou.";
      }
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
  persistLater(job);
  return true;
}
