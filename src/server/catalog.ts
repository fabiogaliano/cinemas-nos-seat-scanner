import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MovieCatalogItem, MovieCatalogResponse, MovieVariant } from "../shared/types";

const DATA_DIR = process.env.CINEMAS_DATA_DIR ?? join(import.meta.dir, "../../data");
const CACHE_FILE = join(DATA_DIR, "catalog-v1.json");
const NOS_ORIGIN = "https://www.cinemas.nos.pt";
const CATALOG_URL = `${NOS_ORIGIN}/graphql/execute.json/cinemas/getAllMovies`;

type StoredCatalog = MovieCatalogResponse & { day: string };
type NosMovie = {
  uuid?: unknown;
  title?: unknown;
  originaltitle?: unknown;
  aggregateformatnumber?: unknown;
  moviestate?: unknown;
  releasedate?: unknown;
  duration?: unknown;
  classification?: unknown;
  genre?: unknown;
  format?: unknown;
  version?: unknown;
  detailurl?: unknown;
  portraitimages?: { path?: unknown };
  landscapeimages?: { path?: unknown };
};

let memory: StoredCatalog | null = null;
let pending: Promise<MovieCatalogResponse> | null = null;

function portugalDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function movieUrl(path: unknown) {
  const value = string(path);
  return value.startsWith("/filmes/") ? new URL(value, NOS_ORIGIN).toString() : "";
}

function imageUrl(path: unknown) {
  const value = string(path);
  if (!value.startsWith("//cdn.nos.pt/cinemas/movies/")) return undefined;
  return `https:${value}`;
}

function formatLabel(value: string) {
  return value.toUpperCase();
}

function toCatalog(raw: unknown): MovieCatalogItem[] {
  if (!Array.isArray(raw)) throw new Error("A NOS devolveu um catálogo inválido.");
  const groups = new Map<string, MovieCatalogItem>();

  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const movie = value as NosMovie;
    const state = string(movie.moviestate);
    if (state !== "InTheaters" && state !== "Premiere") continue;

    const uuid = string(movie.uuid);
    const url = movieUrl(movie.detailurl);
    const groupId = string(movie.aggregateformatnumber) || uuid;
    const title = string(movie.title);
    if (!uuid || !url || !groupId || !title) continue;

    const variant: MovieVariant = {
      id: uuid,
      label: formatLabel(string(movie.format) || "2D"),
      movieUrl: url,
    };
    const existing = groups.get(groupId);
    if (existing) {
      if (!existing.variants.some((item) => item.id === variant.id)) existing.variants.push(variant);
      continue;
    }

    const releaseDate = string(movie.releasedate) || undefined;
    const runtime = Number(string(movie.duration));
    groups.set(groupId, {
      id: groupId,
      nosMovieUuid: uuid,
      movieUrl: url,
      title,
      originalTitle: string(movie.originaltitle) || undefined,
      releaseDate,
      releaseYear: releaseDate ? Number(releaseDate.slice(0, 4)) || undefined : undefined,
      runtimeMinutes: Number.isFinite(runtime) && runtime > 0 ? runtime : undefined,
      genres: string(movie.genre).split(",").map((genre) => genre.trim()).filter(Boolean),
      ageRating: string(movie.classification) || undefined,
      state: state as "InTheaters" | "Premiere",
      posterUrl: imageUrl(movie.portraitimages?.path),
      variants: [variant],
    });
  }

  return [...groups.values()]
    .map((movie) => ({ ...movie, variants: [...movie.variants].sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title));
}

async function readStored() {
  try {
    const stored = JSON.parse(await readFile(CACHE_FILE, "utf8")) as StoredCatalog;
    if (stored?.day && Array.isArray(stored.movies) && typeof stored.fetchedAt === "string") return stored;
  } catch {
    // A missing or incomplete cache must not prevent a fresh source request.
  }
  return null;
}

async function persist(value: StoredCatalog) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CACHE_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, CACHE_FILE);
}

async function refresh(day: string): Promise<MovieCatalogResponse> {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Não foi possível carregar os filmes da NOS.");
  const payload = await response.json() as { data?: { movieList?: { items?: unknown } } };
  const movies = toCatalog(payload.data?.movieList?.items);
  if (movies.length === 0) throw new Error("A NOS não devolveu filmes em cartaz.");
  const catalog: StoredCatalog = { day, movies, fetchedAt: new Date().toISOString(), stale: false, source: "cinemas-nos" };
  await persist(catalog);
  memory = catalog;
  return catalog;
}

export async function getMovieCatalog(): Promise<MovieCatalogResponse> {
  const day = portugalDay();
  if (!memory) memory = await readStored();
  if (memory?.day === day) return memory;
  if (!pending) pending = refresh(day).finally(() => { pending = null; });
  return pending;
}
