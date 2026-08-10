export type Seat = {
  col: number;
  isSeat: boolean;
  free: boolean;
  num: number;
  loveSeat: boolean;
  handicapped: boolean;
};

export type SeatRow = { row: number; seats: Seat[] };

export type Cinema = {
  name: string;
  region: string;
  formats: string[];
};

export type Discovery = {
  movieUrl: string;
  movieTitle: string;
  cinemas: Cinema[];
};

export type MovieVariant = {
  id: string;
  label: string;
  movieUrl: string;
  aggregateId?: string;
};

export type MovieCatalogItem = {
  id: string;
  nosMovieUuid: string;
  movieUrl: string;
  title: string;
  originalTitle?: string;
  releaseDate?: string;
  releaseYear?: number;
  runtimeMinutes?: number;
  genres: string[];
  ageRating?: string;
  state: "InTheaters" | "Premiere";
  posterUrl?: string;
  variants: MovieVariant[];
};

export type MovieCatalogResponse = {
  movies: MovieCatalogItem[];
  fetchedAt: string;
  stale: boolean;
  source: "cinemas-nos";
};

export type Session = {
  label: string;
  cinema: string;
  date: string;
  time: string;
  uuid: string;
  variantId: string;
  variantLabel: string;
  variantPriority: number;
  rows: SeatRow[];
};

export type ScanVariant = MovieVariant & { priority: number };

export type ScanRequest = {
  movieTitle: string;
  variants: ScanVariant[];
  cinemas: string[];
  days: number;
  people: number;
};

export type ScanJob = {
  id: string;
  status: "queued" | "discovering" | "scanning" | "complete" | "failed" | "cancelled";
  movieTitle: string;
  request: ScanRequest;
  sessions: Session[];
  total: number;
  scanned: number;
  currentLabel?: string;
  error?: string;
  failures?: Array<{ label: string; error: string }>;
  createdAt: string;
  revision: number;
};

export type BestBlock = {
  row: number;
  cols: number[];
  nums: number[];
  score: number;
};

export type RankedSession = Session & {
  best: BestBlock | null;
  totalFree: number;
  totalSeats: number;
  minutes: number;
  occupancy: number;
};
