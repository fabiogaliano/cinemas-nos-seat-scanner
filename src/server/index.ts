import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { cancelJob, createJob, loadJobs, waitForJob } from "./jobs";
import { getMovieCatalog } from "./catalog";
import { discover } from "./scanner";
import type { ScanRequest, ScanVariant } from "../shared/types";

const port = Number(process.env.PORT ?? 5757);
const publicDir = process.env.CINEMAS_PUBLIC_DIR ?? join(import.meta.dir, "../../dist");

const headers = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://cdn.nos.pt; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(payload: unknown, status = 200, cacheControl = "no-store") {
  return Response.json(payload, { status, headers: { ...headers, "Cache-Control": cacheControl } });
}

function validateUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Cola o link do filme.");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "www.cinemas.nos.pt" || !url.pathname.startsWith("/filmes/")) {
    throw new Error("Usa um link de filme de www.cinemas.nos.pt.");
  }
  return url.toString();
}

function validateAggregateId(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("O identificador do filme é inválido.");
  return value;
}

function validateScan(value: unknown): ScanRequest {
  if (!value || typeof value !== "object") throw new Error("Pedido inválido.");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.cinemas) || body.cinemas.length === 0 || body.cinemas.some((cinema) => typeof cinema !== "string")) {
    throw new Error("Escolhe pelo menos um cinema.");
  }
  if (typeof body.movieTitle !== "string" || !body.movieTitle.trim()) throw new Error("Escolhe um filme.");
  if (!Array.isArray(body.variants) || body.variants.length === 0 || body.variants.length > 3) throw new Error("Escolhe entre 1 e 3 versões.");
  const variants = body.variants.map((value, index): ScanVariant => {
    if (!value || typeof value !== "object") throw new Error("Versão inválida.");
    const variant = value as Record<string, unknown>;
    if (typeof variant.id !== "string" || typeof variant.label !== "string" || !variant.label.trim()) throw new Error("Versão inválida.");
    const priority = Number(variant.priority);
    if (!Number.isInteger(priority) || priority !== index + 1) throw new Error("A prioridade das versões é inválida.");
    return { id: variant.id, label: variant.label.trim(), movieUrl: validateUrl(variant.movieUrl), aggregateId: validateAggregateId(variant.aggregateId), priority };
  });
  const days = Number(body.days);
  const people = Number(body.people);
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("Escolhe entre 1 e 7 dias.");
  if (!Number.isInteger(people) || people < 1 || people > 10) throw new Error("Escolhe entre 1 e 10 pessoas.");
  return { movieTitle: body.movieTitle.trim(), variants, cinemas: body.cinemas, days, people };
}

function staticFile(pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(publicDir, requested));
  if (!path.startsWith(publicDir) || !existsSync(path)) return null;
  const cacheControl = requested === "index.html" ? "no-cache" : /\.(?:css|js)$/.test(requested) ? "public, max-age=31536000, immutable" : "public, max-age=3600";
  return new Response(Bun.file(path), { headers: { ...headers, "Cache-Control": cacheControl } });
}

await loadJobs();
void getMovieCatalog().catch((error) => console.error("Could not warm movie catalog", error));

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
      if (request.method === "GET" && url.pathname === "/api/movies") {
        try {
          return json(await getMovieCatalog(), 200, "public, max-age=300, stale-while-revalidate=86400");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Não foi possível carregar os filmes da NOS.";
          return json({ error: message }, 503);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/discover") {
        const body = await request.json() as { movieUrl?: unknown; aggregateId?: unknown; movieTitle?: unknown };
        const movieTitle = typeof body.movieTitle === "string" && body.movieTitle.trim() ? body.movieTitle.trim() : "Filme";
        return json(await discover(validateUrl(body.movieUrl), validateAggregateId(body.aggregateId), movieTitle));
      }
      if (request.method === "POST" && url.pathname === "/api/scans") {
        const job = createJob(validateScan(await request.json()));
        return json({ id: job.id }, 202);
      }
      const jobMatch = url.pathname.match(/^\/api\/scans\/([a-f0-9-]+)$/);
      if (jobMatch && request.method === "GET") {
        const after = Math.max(-1, Number(url.searchParams.get("after") ?? -1) || 0);
        const job = await waitForJob(jobMatch[1], after, request.signal);
        return job ? json(job) : json({ error: "Scan não encontrado." }, 404);
      }
      if (jobMatch && request.method === "DELETE") {
        return cancelJob(jobMatch[1]) ? json({ ok: true }) : json({ error: "Este scan já terminou." }, 409);
      }
      if (request.method === "GET") return staticFile(url.pathname) ?? staticFile("/")!;
      return json({ error: "Não encontrado." }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ocorreu um erro inesperado.";
      return json({ error: message }, 400);
    }
  },
});

console.log(`Cinema seat finder listening on :${port}`);
