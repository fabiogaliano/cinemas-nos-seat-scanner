import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { rankSessions } from "../shared/ranking";
import type { Discovery, MovieCatalogItem, MovieCatalogResponse, MovieVariant, RankedSession, ScanJob, ScanRequest, SeatRow } from "../shared/types";
import "./styles.css";

const REGIONS = ["Grande Lisboa", "Grande Porto", "Norte", "Centro", "Sul", "Madeira", "Açores", "Outros"];
type RecentSearch = { id: string; movieTitle: string; request: ScanRequest; sessionCount: number; createdAt: string };
type VariantDiscovery = { variant: MovieVariant; discovery: Discovery };
type View = "start" | "versions" | "configure" | "progress" | "results";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "O pedido falhou.");
  return body as T;
}

const RECENT_KEY = "melhor-lugar-recent-v1";
const RECENT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function readRecentSearches() {
  try {
    const entries = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentSearch[];
    const now = Date.now();
    const recent = entries.filter((entry) => entry && typeof entry.createdAt === "string" && now - new Date(entry.createdAt).getTime() < RECENT_MAX_AGE);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    return recent;
  } catch {
    return [];
  }
}

function saveRecentSearch(job: ScanJob) {
  const entry: RecentSearch = { id: crypto.randomUUID(), movieTitle: job.movieTitle, request: job.request, sessionCount: job.sessions.length, createdAt: job.createdAt };
  const next = [entry, ...readRecentSearches()].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

function removeRecentSearch(id: string) {
  const next = readRecentSearches().filter((entry) => entry.id !== id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

function scanDates(createdAt: string, days: number) {
  const start = new Date(createdAt);
  const end = new Date(start);
  end.setDate(end.getDate() + days - 1);
  const weekdays = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const format = (date: Date) => `${weekdays[date.getDay()]}. ${date.getDate()}, ${months[date.getMonth()]}`;
  return days === 1 ? format(start) : `${format(start)} até ${format(end)}`;
}

function cinemaSummary(cinemas: string[]) {
  const names = cinemas.map((name) => name.replace(/^Cinemas NOS\s+/, ""));
  return names.length > 2 ? `${names.slice(0, 2).join(" · ")} +${names.length - 2}` : names.join(" · ");
}

function searchable(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-PT");
}

function scanWindow(days: number) {
  if (days === 1) return "Hoje";
  const end = new Date();
  end.setDate(end.getDate() + days - 1);
  return `Hoje – ${new Intl.DateTimeFormat("pt-PT", { weekday: "short", day: "numeric", month: "short" }).format(end)}`;
}

function Icon({ name, size = 18 }: { name: "arrow" | "check" | "chevron" | "clock" | "close" | "film" | "location" | "people" | "search" | "grip"; size?: number }) {
  const paths = {
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>, check: <path d="m5 12 4 4L19 6"/>, chevron: <path d="m9 18 6-6-6-6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
    film: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4"/></>,
    location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    people: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-4 2.3-6 5.5-6s5 2 5.5 6"/><path d="M15 5.5a3 3 0 0 1 0 5.8M16 14c2.5.4 3.8 2 4.2 5"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>, grip: <><circle cx="8" cy="7" r="1" fill="currentColor"/><circle cx="16" cy="7" r="1" fill="currentColor"/><circle cx="8" cy="12" r="1" fill="currentColor"/><circle cx="16" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="17" r="1" fill="currentColor"/><circle cx="16" cy="17" r="1" fill="currentColor"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{paths[name]}</svg>;
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (value: number) => void; label: string }) {
  return <div class="stepper" aria-label={label}><button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button><strong>{value}</strong><button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button></div>;
}

function SeatMap({ rows, recommended }: { rows: SeatRow[]; recommended: RankedSession["best"] }) {
  const maxColumns = Math.max(...rows.map((row) => Math.max(...row.seats.map((seat) => seat.col)) + 1));
  return <div class="seat-map-wrap"><div class="seat-map" style={{ "--columns": maxColumns } as never} aria-hidden="true"><div class="screen"><span>ECRÃ</span></div>{rows.map((row) => <div class="seat-row" key={row.row}><span class="row-name">{row.row}</span><div class="seat-columns">{Array.from({ length: maxColumns }, (_, col) => {
    const seat = row.seats.find((candidate) => candidate.col === col);
    const isRecommended = seat?.isSeat && recommended?.row === row.row && recommended.cols.includes(col);
    return <span key={col} class={`seat ${!seat?.isSeat ? "seat-gap" : isRecommended ? "seat-best" : seat.free ? "seat-free" : "seat-taken"}`}/>;
  })}</div></div>)}</div></div>;
}

function Results({ job, onNew }: { job: ScanJob; onNew: () => void }) {
  const [partySize, setPartySize] = useState(job.request.people);
  const [cinemas, setCinemas] = useState(() => new Set(job.request.cinemas.map((name) => name.replace(/^Cinemas NOS\s+/, ""))));
  const [dates, setDates] = useState<Set<string>>(new Set());
  const ranked = useMemo(() => {
    const groups = new Map<number, typeof job.sessions>();
    for (const session of job.sessions) groups.set(session.variantPriority, [...(groups.get(session.variantPriority) ?? []), session]);
    return [...groups.entries()].sort(([a], [b]) => a - b).flatMap(([, sessions]) => rankSessions(sessions, partySize));
  }, [job.sessions, partySize]);
  const filtered = ranked.filter((session) => cinemas.has(session.cinema) && (dates.size === 0 || dates.has(session.date)));
  const [selectedId, setSelectedId] = useState(ranked[0]?.uuid ?? "");
  const selected = filtered.find((session) => session.uuid === selectedId) ?? filtered[0];
  const allDates = [...new Set(ranked.map((session) => session.date))];
  const priority = new Map(job.request.variants.map((variant) => [variant.priority, variant]));
  const toggle = (set: Set<string>, value: string, allowEmpty = true) => { const next = new Set(set); next.has(value) ? next.delete(value) : next.add(value); if (allowEmpty || next.size) return next; return set; };

  return <main class="results-shell"><header class="app-header"><button class="brand" onClick={onNew}><span class="brand-mark"><Icon name="film" size={17}/></span><span>Melhor Lugar</span></button><button class="secondary small" onClick={onNew}>Novo filme</button></header>
    <section class="results-heading"><div><p class="eyebrow">{job.sessions.length} sessões analisadas</p><h1>{job.movieTitle}</h1></div><div class="party-control"><span><Icon name="people"/> Pessoas</span><Stepper value={partySize} min={1} max={10} onChange={setPartySize} label="pessoas"/></div></section>
    <section class="filter-row" aria-label="Filtros">{[...new Set(ranked.map((session) => session.cinema))].map((cinema) => <button key={cinema} class={`filter-chip ${cinemas.has(cinema) ? "active" : ""}`} aria-pressed={cinemas.has(cinema)} onClick={() => setCinemas(toggle(cinemas, cinema, false))}><Icon name="location" size={15}/>{cinema}</button>)}<span class="filter-divider"/><button class={`filter-chip ${dates.size === 0 ? "active" : ""}`} aria-pressed={dates.size === 0} onClick={() => setDates(new Set())}>Todas as datas</button>{allDates.map((date) => <button key={date} class={`filter-chip ${dates.has(date) ? "active" : ""}`} aria-pressed={dates.has(date)} onClick={() => setDates(toggle(dates, date))}>{date}</button>)}</section>
    {selected ? <div class="results-layout"><aside class="session-panel"><div class="panel-title"><span>Melhores sessões</span><span>{filtered.length}</span></div><div class="session-list">{[...new Set(filtered.map((session) => session.variantPriority))].map((tier) => <section class="result-tier" key={tier}><h2>{tier}. {priority.get(tier)?.label ?? filtered.find((session) => session.variantPriority === tier)?.variantLabel}</h2>{filtered.filter((session) => session.variantPriority === tier).map((session, index) => <button class={`session-card ${selected.uuid === session.uuid ? "selected" : ""}`} onClick={() => setSelectedId(session.uuid)}><span class="rank">{String(index + 1).padStart(2, "0")}</span><span class="session-main"><strong>{session.date} · {session.time}</strong><span>{session.cinema}</span><small>{session.best ? `Fila ${session.best.row} · lugares ${session.best.nums.join("–")}` : `Sem ${partySize} lugares juntos`}</small></span><span class="occupancy"><b>{Math.round(session.occupancy * 100)}%</b><small>ocupado</small></span><Icon name="chevron" size={16}/></button>)}</section>)}</div></aside>
      <article class="map-panel"><div class="map-head"><div><p>{selected.variantLabel} · {selected.cinema}</p><h2>{selected.date}, {selected.time}</h2></div><div class="availability"><span class="status-dot"/><strong>{selected.totalFree}</strong> livres de {selected.totalSeats}</div></div>{selected.best ? <div class="recommendation"><span class="recommendation-icon"><Icon name="check"/></span><div><small>Melhor bloco para {partySize}</small><strong>Fila {selected.best.row}, lugares {selected.best.nums.join("–")}</strong></div></div> : <div class="recommendation unavailable"><div><small>Sem bloco disponível</small><strong>Não há {partySize} lugares seguidos nesta sessão.</strong></div></div>}<SeatMap rows={selected.rows} recommended={selected.best}/><div class="map-footer"><div class="legend"><span><i class="legend-free"/>Livre</span><span><i class="legend-taken"/>Ocupado</span><span><i class="legend-best"/>Recomendado</span></div><a class="primary book-link" href={`https://bilheteira.cinemas.nos.pt/Cinemas/Ticket?SessionUUID=${selected.uuid}`} target="_blank" rel="noreferrer">Abrir na NOS <Icon name="arrow"/></a></div></article></div> : <div class="empty-state"><h2>Sem sessões com estes filtros</h2><p>Volta a ativar um cinema ou uma data.</p></div>}
  </main>;
}

function App() {
  const [view, setView] = useState<View>("start");
  const [catalog, setCatalog] = useState<MovieCatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [movie, setMovie] = useState<MovieCatalogItem | null>(null);
  const [variants, setVariants] = useState<MovieVariant[]>([]);
  const [discoveries, setDiscoveries] = useState<VariantDiscovery[]>([]);
  const [selectedCinemas, setSelectedCinemas] = useState<Set<string>>(new Set());
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [days, setDays] = useState(5); const [people, setPeople] = useState(2);
  const [job, setJob] = useState<ScanJob | null>(null); const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [manualUrl, setManualUrl] = useState(""); const [movieQuery, setMovieQuery] = useState("");

  useEffect(() => { setRecent(readRecentSearches()); void api<MovieCatalogResponse>(`/api/movies?v=${__BUILD_VERSION__}`).then(setCatalog).catch((requestError) => setCatalogError(requestError instanceof Error ? requestError.message : "Não conseguimos carregar os filmes.")); }, []);
  useEffect(() => {
    if (view !== "progress" || !job || ["complete", "failed", "cancelled"].includes(job.status)) return;
    const controller = new AbortController();
    void (async () => {
      let revision = job.revision;
      while (!controller.signal.aborted) {
        try {
          const next = await api<ScanJob>(`/api/scans/${job.id}?after=${revision}`, { signal: controller.signal });
          revision = next.revision;
          setJob(next);
          if (next.status === "complete") { setRecent(saveRecentSearch(next)); setView("results"); return; }
          if (next.status === "failed" || next.status === "cancelled") return;
        } catch (requestError) {
          if (controller.signal.aborted) return;
          setError(requestError instanceof Error ? requestError.message : "Perdemos a ligação ao scan.");
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
    })();
    return () => controller.abort();
  }, [view, job?.id, job?.status]);

  const cinemas = useMemo(() => { const all = new Map<string, Discovery["cinemas"][number]>(); for (const item of discoveries) for (const cinema of item.discovery.cinemas) all.set(cinema.name, cinema); return [...all.values()]; }, [discoveries]);
  const visibleMovies = useMemo(() => { const query = searchable(movieQuery.trim()); return catalog?.movies.filter((item) => !query || searchable(`${item.originalTitle ?? ""} ${item.title}`).includes(query)) ?? []; }, [catalog, movieQuery]);
  const title = movie ? (movie.originalTitle || movie.title) : discoveries[0]?.discovery.movieTitle || "Filme";
  const selectMovie = (item: MovieCatalogItem) => { setMovie(item); setVariants([]); setError(""); setView("versions"); };
  const toggleVariant = (variant: MovieVariant) => setVariants((current) => current.some((item) => item.id === variant.id) ? current.filter((item) => item.id !== variant.id) : current.length === 3 ? current : [...current, variant]);
  const moveVariant = (id: string, offset: number) => setVariants((current) => { const source = current.findIndex((item) => item.id === id); const target = source + offset; if (source < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[source], next[target]] = [next[target], next[source]]; return next; });
  async function prepareVariants() { if (!movie || variants.length === 0) return; setBusy(true); setError(""); try { const found = await Promise.all(variants.map(async (variant) => ({ variant, discovery: await api<Discovery>("/api/discover", { method: "POST", body: JSON.stringify({ movieUrl: variant.movieUrl, aggregateId: variant.aggregateId, movieTitle: movie.originalTitle || movie.title }) }) }))); setDiscoveries(found); setSelectedCinemas(new Set()); setActiveRegion(null); setView("configure"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não conseguimos preparar essas versões."); } finally { setBusy(false); } }
  async function openManual(event: Event) { event.preventDefault(); setBusy(true); setError(""); try { const discovery = await api<Discovery>("/api/discover", { method: "POST", body: JSON.stringify({ movieUrl: manualUrl }) }); const variant = { id: "manual", label: "Sessões", movieUrl: discovery.movieUrl }; setMovie(null); setVariants([variant]); setDiscoveries([{ variant, discovery }]); setSelectedCinemas(new Set()); setActiveRegion(null); setView("configure"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não conseguimos abrir esse filme."); } finally { setBusy(false); } }
  async function runScan(request: ScanRequest) { setBusy(true); setError(""); try { const { id } = await api<{ id: string }>("/api/scans", { method: "POST", body: JSON.stringify(request) }); setJob({ id, request, status: "queued", movieTitle: request.movieTitle, sessions: [], total: 0, scanned: 0, failures: [], createdAt: new Date().toISOString(), revision: 0 }); setView("progress"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não conseguimos iniciar o scan."); } finally { setBusy(false); } }
  async function startScan() { if (!selectedCinemas.size || !variants.length) return; await runScan({ movieTitle: title, variants: variants.map((variant, index) => ({ ...variant, priority: index + 1 })), cinemas: [...selectedCinemas], days, people }); }
  async function repeatSearch(scan: RecentSearch) {
    const knownVariants = catalog?.movies.flatMap((item) => item.variants) ?? [];
    const request = { ...scan.request, variants: scan.request.variants.map((variant) => ({ ...variant, aggregateId: variant.aggregateId ?? knownVariants.find((known) => known.id === variant.id)?.aggregateId })) };
    await runScan(request);
  }
  const toggleCinema = (name: string) => setSelectedCinemas((current) => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next; });
  const reset = () => { setView("start"); setMovie(null); setVariants([]); setDiscoveries([]); setSelectedCinemas(new Set()); setActiveRegion(null); setJob(null); setError(""); };
  if (view === "results" && job) return <Results job={job} onNew={reset}/>;

  return <main class="setup-shell"><header class="app-header setup-header"><button class="brand" onClick={reset}><span class="brand-mark"><Icon name="film" size={17}/></span><span>Melhor Lugar</span></button><span class="header-note">Cinemas NOS</span></header>
    {view === "start" ? <div class="catalog-shell"><section class="catalog-heading"><p class="eyebrow">Cinemas NOS</p><div class="catalog-title-row"><div><h1>Filmes em cartaz</h1><p>Atualizados uma vez por dia.</p></div>{catalog ? <label class="movie-search"><span class="sr-only">Procurar filme</span><Icon name="search"/><input type="search" value={movieQuery} onInput={(event) => setMovieQuery(event.currentTarget.value)} placeholder="Procurar filme…"/></label> : null}</div></section>{recent.length > 0 && !movieQuery ? <section class="recent-section"><div class="section-heading"><h2>Pesquisas recentes</h2><span>Últimos 7 dias</span></div><div class="recent-list">{recent.map((scan) => <article class="recent-search" key={scan.id}><button class="recent-reopen" onClick={() => repeatSearch(scan)}><span><strong>{scan.movieTitle}</strong><span>{cinemaSummary(scan.request.cinemas)}</span><small>{scanDates(scan.createdAt, scan.request.days)} · {scan.request.variants.map((variant) => variant.label).join(" → ")}</small></span><b>Repetir</b></button><button class="recent-remove" onClick={() => setRecent(removeRecentSearch(scan.id))} aria-label={`Remover ${scan.movieTitle}`}><Icon name="close" size={16}/></button></article>)}</div></section> : null}{catalog ? visibleMovies.length ? <section class="movie-grid" aria-label="Filmes em cartaz">{visibleMovies.map((item, index) => <button key={item.id} class="movie-card" onClick={() => selectMovie(item)}><span class="movie-poster">{item.posterUrl ? <img src={item.posterUrl} alt="" loading={index < 6 ? "eager" : "lazy"} fetchPriority={index < 3 ? "high" : "auto"}/> : <span><Icon name="film"/></span>}</span><span class="movie-card-copy"><strong>{item.originalTitle || item.title}</strong><small>{item.runtimeMinutes ? `${item.runtimeMinutes} min` : "Duração por confirmar"}{item.ageRating ? ` · ${item.ageRating}` : ""}</small></span></button>)}</section> : <section class="catalog-empty"><h2>Nenhum filme encontrado</h2><button class="text-button" onClick={() => setMovieQuery("")}>Limpar pesquisa</button></section> : catalogError ? <section class="catalog-error"><div><Icon name="close" size={24}/><h1>O cartaz não está disponível.</h1><p>{catalogError} Cola o link do filme da Cinemas NOS para continuar.</p></div><form class="url-form" onSubmit={openManual}><label for="movie-url">Link do filme na Cinemas NOS</label><div class={`url-input ${error ? "has-error" : ""}`}><Icon name="search"/><input id="movie-url" type="url" value={manualUrl} onInput={(event) => setManualUrl(event.currentTarget.value)} placeholder="cinemas.nos.pt/filmes/…" required/><button class="primary" disabled={busy}>{busy ? <span class="spinner"/> : <>Continuar <Icon name="arrow"/></>}</button></div>{error ? <p class="form-error">{error}</p> : null}</form></section> : <section class="movie-grid movie-grid-loading" aria-label="A carregar filmes">{Array.from({ length: 12 }, (_, index) => <span class="movie-card-skeleton" key={index}/>)}</section>}</div> : null}
    {view === "versions" && movie ? <section class="version-picker view-enter"><nav class="setup-progress" aria-label="Progresso"><span>Filme</span><strong>Versões</strong><span>Detalhes</span></nav><button class="back-button" aria-label="Voltar aos filmes" onClick={() => setView("start")}>←</button><p class="eyebrow">{movie.runtimeMinutes} min{movie.ageRating ? ` · ${movie.ageRating}` : ""}</p><h1>{movie.originalTitle || movie.title}</h1><p class="version-intro">Escolhe até três versões. A primeira é a tua preferência.</p><div class="variant-options">{movie.variants.map((variant) => <button key={variant.id} class={`variant-option ${variants.some((item) => item.id === variant.id) ? "selected" : ""}`} aria-pressed={variants.some((item) => item.id === variant.id)} onClick={() => toggleVariant(variant)} disabled={!variants.some((item) => item.id === variant.id) && variants.length === 3}><span>{variant.label}</span>{variants.some((item) => item.id === variant.id) ? <Icon name="check"/> : null}</button>)}</div>{variants.length ? <div class="priority-list">{variants.map((variant, index) => <div class="priority-chip" key={variant.id}><span class="priority-number">{index + 1}</span><strong>{variant.label}</strong>{variants.length > 1 ? <span class="priority-actions"><button aria-label={`Subir ${variant.label}`} disabled={index === 0} onClick={() => moveVariant(variant.id, -1)}>↑</button><button aria-label={`Descer ${variant.label}`} disabled={index === variants.length - 1} onClick={() => moveVariant(variant.id, 1)}>↓</button></span> : null}</div>)}</div> : <p class="selection-prompt">Escolhe pelo menos uma versão.</p>}{error ? <p class="form-error">{error}</p> : null}<div class="picker-footer"><button class="secondary" onClick={() => setView("start")}>Voltar</button><button class="primary large" disabled={!variants.length || busy} onClick={prepareVariants}>{busy ? <span class="spinner"/> : <>Escolher cinemas <Icon name="arrow"/></>}</button></div></section> : null}
    {view === "configure" ? <section class="configure-card view-enter"><nav class="setup-progress" aria-label="Progresso"><span>Filme</span><span>Versões</span><strong>Detalhes</strong></nav><div class="configure-head"><button class="back-button" aria-label="Voltar às versões" onClick={() => setView(movie ? "versions" : "start")}>←</button><div><p class="eyebrow">Configurar scan</p><h1>{title}</h1><p class="selected-versions">{variants.map((variant) => variant.label).join(" → ")}</p></div></div><div class="config-section"><div class="config-title"><span>1</span><div><h2>Onde queres ver?</h2><p>Escolhe uma zona e depois os cinemas.</p></div></div><div class="region-picker">{REGIONS.map((region) => { const list = cinemas.filter((cinema) => cinema.region === region); const selected = list.filter((cinema) => selectedCinemas.has(cinema.name)).length; return list.length ? <button key={region} class={`region-option ${activeRegion === region ? "active" : ""}`} aria-pressed={activeRegion === region} onClick={() => setActiveRegion(activeRegion === region ? null : region)}><span><strong>{region}</strong><small>{list.length} {list.length === 1 ? "cinema" : "cinemas"}</small></span>{selected ? <b>{selected}</b> : <Icon name="chevron" size={16}/>}</button> : null; })}</div>{activeRegion ? <div class="cinema-region-panel"><div class="cinema-region-head"><h3>{activeRegion}</h3><span>{selectedCinemas.size ? `${selectedCinemas.size} ${selectedCinemas.size === 1 ? "escolhido" : "escolhidos"} no total` : "Escolhe um ou mais"}</span></div><div class="cinema-options-grid">{cinemas.filter((cinema) => cinema.region === activeRegion).map((cinema) => <label key={cinema.name} class={`cinema-option ${selectedCinemas.has(cinema.name) ? "selected" : ""}`}><input type="checkbox" checked={selectedCinemas.has(cinema.name)} onChange={() => toggleCinema(cinema.name)}/><span class="custom-check"><Icon name="check" size={14}/></span><span>{cinema.name.replace(/^Cinemas NOS\s+/, "")}</span></label>)}</div></div> : <p class="region-prompt">Escolhe uma zona para ver os cinemas.</p>}</div><div class="config-section"><div class="config-title"><span>2</span><div><h2>Quando e para quantas pessoas?</h2><p>Vamos procurar a melhor fila em cada versão escolhida.</p></div></div><div class="scan-options"><div class="number-control"><label>Dias</label><Stepper value={days} min={1} max={7} onChange={setDays} label="dias"/><small>{scanWindow(days)}</small></div><div class="number-control"><label>Pessoas</label><Stepper value={people} min={1} max={10} onChange={setPeople} label="pessoas"/></div></div></div>{error ? <p class="form-error config-error">{error}</p> : null}<div class="configure-footer"><p>{selectedCinemas.size ? `${selectedCinemas.size} ${selectedCinemas.size === 1 ? "cinema" : "cinemas"} · ${variants.length} ${variants.length === 1 ? "versão" : "versões"}` : "Escolhe pelo menos um cinema"}</p><button class="primary large" disabled={busy || !selectedCinemas.size} onClick={startScan}>{busy ? <span class="spinner"/> : <>Analisar sessões <Icon name="arrow"/></>}</button></div></section> : null}
    {view === "progress" && job ? <section class="progress-card view-enter" aria-live="polite">{job.status === "failed" || job.status === "cancelled" ? <><div class="progress-icon failed"><Icon name="close" size={28}/></div><p class="eyebrow">O scan parou</p><h1>{job.status === "cancelled" ? "Scan cancelado" : "Não conseguimos terminar"}</h1><p>{job.error ?? "Podes voltar a tentar."}</p><button class="primary" onClick={() => setView("configure")}>Voltar à configuração</button></> : <><div class="progress-icon"><span class="scanner-line"/><Icon name="film" size={30}/></div><p class="eyebrow">A analisar em tempo real</p><h1>{job.movieTitle}</h1><p>{job.status === "queued" ? "O teu scan está na fila…" : job.status === "discovering" ? "A encontrar sessões…" : job.currentLabel ?? "A abrir as salas e a contar lugares…"}</p><div class="progress-track"><span style={{ transform: `scaleX(${job.total ? job.scanned / job.total : 0.08})` }}/></div><div class="progress-meta"><span>{job.scanned} de {job.total || "…"} sessões</span><span>{job.total ? `${Math.round(job.scanned / job.total * 100)}%` : ""}</span></div><button class="text-button" onClick={() => void api(`/api/scans/${job.id}`, { method: "DELETE" }).then(() => setJob({ ...job, status: "cancelled" }))}>Cancelar scan</button></>}</section> : null}
  </main>;
}

render(<App/>, document.getElementById("app")!);
