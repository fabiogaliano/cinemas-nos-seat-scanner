#!/usr/bin/env node
// Cinemas NOS seat-availability scanner.
//
// Drives a dedicated, throwaway Chrome instance (not your daily browser — avoids
// the CDP attach latency that comes from a browser loaded with 50+ tabs) through
// the real booking flow for every session of a movie at a given cinema, and dumps
// a browsable HTML seat-map viewer.
//
// Why a real browser and not plain HTTP: Cinemas NOS is an OutSystems reactive
// app that round-trips its entire accumulated client state on every API call
// (a single booking-creation call carries ~1.7MB of JSON, including the whole
// room's seat data as an echo field). Replicating that by hand is fragile and
// breaks on any frontend update; a real browser carries that state for free.
//
// Usage:
//   node scan.cjs "<movie page URL>" --cinema "Colombo" --format imax --days 5 --people 2
//
// Movie page URL example:
//   https://www.cinemas.nos.pt/filmes/a-odisseia--imax--514040668

const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CDP_BIN = '/Users/f/.claude/skills/chrome-cdp/scripts/cdp.mjs';
const PORT = 9229;
const PROFILE_DIR = '/tmp/chrome-nos-profile';
const OUT_DIR = path.join(__dirname, 'runs');

function cdp(args) {
  return execFileSync(CDP_BIN, ['--port', String(PORT), ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// cdp.mjs resolves a target prefix (e.g. for eval/nav) against a local cache file
// that's only refreshed by "cdp list" — a freshly opened tab isn't in it yet, so
// any command against a brand-new target fails until list runs once. Not a real
// attach delay; just refresh the cache immediately after opening.
function refreshTargetCache() {
  cdp(['list']);
}

async function ensureChrome(headless) {
  try {
    execFileSync('curl', ['-sf', '--max-time', '2', `http://localhost:${PORT}/json/version`], { stdio: 'ignore' });
    return; // already running
  } catch {}
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const flags = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
  ];
  if (headless) flags.push('--headless=new');
  flags.push('about:blank');
  const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', flags, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      execFileSync('curl', ['-sf', '--max-time', '1', `http://localhost:${PORT}/json/version`], { stdio: 'ignore' });
      return;
    } catch {}
  }
  throw new Error('Dedicated Chrome did not come up on port ' + PORT);
}

async function openTab(url) {
  const out = cdp(['open', url]);
  const m = out.match(/target: ([0-9A-Fa-f]+)/);
  if (!m) throw new Error('Could not open tab: ' + out);
  refreshTargetCache();
  return m[1].slice(0, 8);
}

async function evalJs(target, expr) {
  return cdp(['eval', target, expr]);
}

function closeTab(target) {
  try {
    const info = JSON.parse(cdp(['evalraw', target, 'Target.getTargetInfo', '{}']));
    cdp(['evalraw', target, 'Target.closeTarget', JSON.stringify({ targetId: info.targetInfo.targetId })]);
  } catch {}
}

// ---------------------------------------------------------------------------
// Step 1: discover session UUIDs for a movie/cinema/format across N days
// ---------------------------------------------------------------------------

// cinemas is an array so callers can scan several theaters in one pass (the
// date buttons are shared page state, so we click each date once and read
// every cinema's sessions off it rather than reopening the page per cinema).
async function discoverSessions(target, cinemas, format, days) {
  await sleep(1500); // let the movie page's session widget finish its initial load

  const dateButtonsRaw = await evalJs(target, `
    Array.from(document.querySelectorAll('button'))
      .map(b => b.textContent.trim())
      .filter(t => /^(Hoje|Amanh[aã]|[A-Za-zçãéê-]+-feira \\d{2}\\/\\d{2})$/.test(t))
  `);
  const dateButtons = JSON.parse(dateButtonsRaw).slice(0, days);

  const sessions = [];
  for (const dateLabel of dateButtons) {
    await evalJs(target, `
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(dateLabel)});
        if (b) b.click();
        return !!b;
      })()
    `);
    await sleep(1500);
    const found = await evalJs(target, `
      (() => {
        const cinemas = ${JSON.stringify(cinemas)};
        const format = ${JSON.stringify(format.toLowerCase())};
        const out = [];
        for (const cinema of cinemas) {
          const theater = Array.from(document.querySelectorAll('.movie-detail__sessions-list__theater-title'))
            .find(h => h.textContent.includes(cinema));
          if (!theater) continue;
          const container = theater.closest('.movie-detail__sessions-list__container__theater');
          const fmtBlock = container.querySelector('[data-format='+JSON.stringify(format)+']');
          if (!fmtBlock) continue;
          for (const b of fmtBlock.querySelectorAll('button')) {
            out.push({ cinema, time: b.textContent.trim(), uuid: b.dataset.uuid });
          }
        }
        return out;
      })()
    `);
    for (const s of JSON.parse(found)) {
      sessions.push({ label: `${s.cinema} — ${dateLabel} ${s.time}`, cinema: s.cinema, date: dateLabel, time: s.time, uuid: s.uuid });
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Step 2: scan seat availability for one session UUID
// ---------------------------------------------------------------------------

const patchExpr = `
(() => {
  window.__cap = [];
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body){
    this.addEventListener('load', () => window.__cap.push({url:this.__u, resBody:this.responseText}));
    return oSend.apply(this, arguments);
  };
  return 'patched';
})()
`;

// Clicks a button by exact text and verifies it actually took effect (the button
// itself disappears once its click handler runs) before moving on — a plain
// click-and-hope sometimes loses the race with React's event wiring, especially
// under headless, and silently stalls the whole flow if not caught.
async function clickAndVerify(target, buttonText, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const clicked = await evalJs(target, `(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(buttonText)}); b&&b.click(); return !!b;})()`);
    if (clicked.trim() === 'false') return true; // button never present — already past this step
    await sleep(800);
    const stillThere = await evalJs(target, `(()=>!!Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(buttonText)}))()`);
    if (stillThere.trim() === 'false') return true;
  }
  return false;
}

async function scanSeats(target, uuid) {
  const navUrl = `https://bilheteira.cinemas.nos.pt/Cinemas/Ticket?SessionUUID=${uuid}&CorrelationId=scan-${uuid.slice(0, 8)}`;
  cdp(['nav', target, navUrl]);
  await evalJs(target, patchExpr);
  await sleep(1200);
  await clickAndVerify(target, 'Continuar sem registo');
  await clickAndVerify(target, 'Continuar');
  await sleep(1500);

  // Keep every seat's real grid column (Col) and seat-type flags — the site's
  // rows aren't a plain 1..N strip, they have aisle gaps, split left/centre/right
  // blocks, love seats, and wheelchair spots, and Col is the only field that
  // encodes true physical position (SeatNumber has unexplained gaps of its own).
  const out = await evalJs(target, `
    (() => {
      const entry = window.__cap.find(c => c.url.includes('SeatsGet'));
      if (!entry) return { error: 'no seatsget captured', url: location.href };
      const json = JSON.parse(entry.resBody);
      const rows = json.data.QueuesAndSeats_LR.List.map(r => ({
        row: r.Row,
        seats: r.LocalSeats.List.map(s => ({
          col: s.Col,
          isSeat: s.isSeat,
          free: s.isAvailable,
          num: s.SeatNumber,
          loveSeat: s.isLoveSeat,
          handicapped: s.isHandicapped,
        })).sort((a,b) => a.col - b.col),
      })).filter(r => r.seats.some(s => s.isSeat));
      return { rows };
    })()
  `);
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// Step 3: HTML viewer — all scoring/sorting/filtering happens client-side so
// party size and time-range filters are instant, no re-scan needed.
// ---------------------------------------------------------------------------

function buildHtml(title, results, initialPeople) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#16181c;color:#e6e6e6;margin:0;padding:24px 24px 160px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
.sub{color:#8a8f98;font-size:13px;margin-bottom:20px}

.controls{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end;background:#1c1f25;border:1px solid #2a2d34;border-radius:10px;padding:14px 18px;margin-bottom:20px}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:11px;color:#8a8f98;text-transform:uppercase;letter-spacing:.04em}
.stepper{display:flex;align-items:center;gap:8px}
.stepper button{width:28px;height:28px;border-radius:6px;border:1px solid #33363d;background:#22252b;color:#e6e6e6;font-size:16px;cursor:pointer}
.stepper button:hover{background:#2a2e36}
.stepper span{min-width:20px;text-align:center;font-size:14px}
.rangewrap{position:relative;width:220px;height:32px}
.rangewrap input[type=range]{position:absolute;left:0;right:0;top:12px;width:100%;pointer-events:none;-webkit-appearance:none;background:transparent}
.rangewrap input[type=range]::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#e6e6e6;cursor:pointer;margin-top:-6px}
.rangewrap input[type=range]::-webkit-slider-runnable-track{height:2px;background:#33363d}
.rangelabels{display:flex;justify-content:space-between;font-size:11px;color:#a8adb5;margin-top:2px}
.cinemachips{display:flex;flex-wrap:wrap;gap:6px;max-width:280px}
.chip{background:#22252b;border:1px solid #33363d;color:#a8adb5;border-radius:14px;padding:5px 12px;font-size:12px;cursor:pointer;user-select:none}
.chip.active{background:#2a3d2f;border-color:#3ea36a;color:#8fe0ab}

.nav{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.nav button{background:#22252b;border:1px solid #33363d;color:#e6e6e6;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer}
.nav button:hover{background:#2a2e36}
.nav button:disabled{opacity:.35;cursor:default}
.navpos{font-size:13px;color:#a8adb5;min-width:60px;text-align:center}
.pinbtn{margin-left:auto;background:#2a3d2f;border:1px solid #3ea36a;color:#8fe0ab;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer}
.pinbtn.pinned{background:#3ea36a;color:#0e1a12}

.card{background:#1c1f25;border:1px solid #2a2d34;border-radius:10px;padding:18px}
.cardhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.cardhead .label{font-size:16px;font-weight:600}
.stats{font-size:13px;color:#a8adb5}
.reco{font-size:13px;color:#e0c95f;margin-bottom:10px}
.screen{text-align:center;color:#6b7280;font-size:11px;letter-spacing:4px;margin-bottom:18px;border-bottom:2px solid #3a3f4a;padding-bottom:8px}
.grid{display:flex;flex-direction:column;gap:3px;align-items:center}
.row{display:flex;gap:2px;align-items:center}
.rowlabel{width:28px;font-size:10px;color:#6b7280;text-align:right;margin-right:6px}
.seat{width:14px;height:14px;border-radius:3px 3px 6px 6px;background:#2c313a}
.seat.free{background:#3ea36a}
.seat.busy{background:#4a4e57}
.seat.reco{box-shadow:0 0 0 2px #e0c95f;background:#e0c95f}
.seat.handi{box-shadow:inset 0 0 0 2px #5b8fd6}
.seat.love{box-shadow:inset 0 0 0 2px #d66b9e}
.legend{display:flex;gap:18px;margin-top:18px;font-size:12px;color:#a8adb5}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:12px;height:12px;border-radius:3px;display:inline-block}

.pinned-dock{position:fixed;left:0;right:0;bottom:0;background:#1c1f25;border-top:1px solid #2a2d34;padding:10px 16px;display:none;gap:10px;overflow-x:auto;justify-content:flex-end}
.pinned-dock.show{display:flex}
.pin-card{flex:0 0 auto;width:190px;background:#22252b;border:1px solid #33363d;border-radius:8px;padding:10px;cursor:pointer;position:relative}
.pin-card:hover{border-color:#4a4e57}
.pin-card .x{position:absolute;top:4px;right:6px;color:#8a8f98;font-size:12px;cursor:pointer}
.pin-card .label{font-size:12px;font-weight:600;margin-bottom:2px}
.pin-card .mini{font-size:10px;color:#8a8f98;margin-bottom:6px}
.mini-grid{display:flex;flex-direction:column;gap:1px}
.mini-row{display:flex;gap:1px}
.mini-seat{width:4px;height:4px;background:#4a4e57}
.mini-seat.free{background:#3ea36a}
.mini-seat.reco{background:#e0c95f}
</style></head><body>
<h1>${title}</h1>
<div class="sub">Seat availability and real grid layout (aisles, gaps, side blocks) captured directly from the booking API. Recommended seats are computed live from your party size — nothing here needs a re-scan.</div>

<div class="controls">
  <div class="field">
    <label>People</label>
    <div class="stepper">
      <button id="peopleDown">−</button>
      <span id="peopleVal"></span>
      <button id="peopleUp">+</button>
    </div>
  </div>
  <div class="field">
    <label>Earliest — Latest</label>
    <div class="rangewrap">
      <input type="range" id="timeMin" min="0" max="1439" step="5">
      <input type="range" id="timeMax" min="0" max="1439" step="5">
    </div>
    <div class="rangelabels"><span id="timeMinLabel"></span><span id="timeMaxLabel"></span></div>
  </div>
  <div class="field" id="cinemaFilterField" style="display:none">
    <label>Cinemas</label>
    <div class="cinemachips" id="cinemaChips"></div>
  </div>
</div>

<div class="nav">
  <button id="prevBtn">&larr; Prev</button>
  <div class="navpos" id="navPos"></div>
  <button id="nextBtn">Next &rarr;</button>
  <button class="pinbtn" id="pinBtn">☆ Pin to compare</button>
</div>

<div class="card">
  <div class="cardhead"><div class="label" id="curLabel"></div><div class="stats" id="curStats"></div></div>
  <div class="reco" id="curReco"></div>
  <div class="screen">S C R E E N</div>
  <div class="grid" id="curGrid"></div>
  <div class="legend"><span><span class="sw" style="background:#3ea36a"></span> free</span><span><span class="sw" style="background:#4a4e57"></span> taken</span><span><span class="sw" style="background:#e0c95f"></span> recommended</span></div>
</div>

<div class="pinned-dock" id="pinnedDock"></div>

<script>
const RAW = ${JSON.stringify(results)};
let people = ${initialPeople};
let pinned = []; // FIFO array of uuids

function timeToMinutes(t){ const [h,m]=t.split(':').map(Number); return h*60+m; }
function isLateNight(t){ const h=Number(t.split(':')[0]); return h>=23 || h<5; }

// row.seats already carries every grid position (Col) for that row, including
// aisle gaps (isSeat:false) — this is the real, authoritative layout from the
// booking API, not a guess from seat-number ranges.
function rowSeatCount(row){ return row.seats.filter(s=>s.isSeat).length; }
function rowFreeCount(row){ return row.seats.filter(s=>s.isSeat && s.free).length; }

// Empirical row desirability: rows that fill up fastest across every scanned
// session are the ones people actually prefer, rather than guessing geometry
// from row size alone.
function computeRowDesirability(sessions){
  const stats = {};
  for (const s of sessions) for (const r of s.rows) {
    const total = rowSeatCount(r);
    if (total===0) continue;
    const free = rowFreeCount(r);
    stats[r.row] ??= {sum:0,n:0};
    stats[r.row].sum += (total-free)/total;
    stats[r.row].n++;
  }
  const out = {};
  for (const [row,st] of Object.entries(stats)) out[row]=st.sum/st.n;
  return out;
}
const ROW_DESIRABILITY = computeRowDesirability(RAW);

// Finds the best contiguous block of N free seats across all rows, walking
// real adjacent grid columns (so aisle gaps correctly break a "contiguous"
// run) rather than assuming seat numbers are gap-free. Prefers rows with
// higher empirical desirability, then the most centered position within the
// row's actual seat span.
function bestBlock(rows, n){
  let best = null;
  for (const r of rows) {
    const seatCols = r.seats.filter(s=>s.isSeat).map(s=>s.col);
    if (!seatCols.length) continue;
    const rowMinCol = Math.min(...seatCols), rowMaxCol = Math.max(...seatCols);
    const rowMid = (rowMinCol+rowMaxCol)/2;
    const desirability = ROW_DESIRABILITY[r.row] ?? 0;

    const freeCols = r.seats.filter(s=>s.isSeat && s.free).map(s=>s.col).sort((a,b)=>a-b);
    let runStart=null, prev=null, runs=[];
    for (const c of freeCols){
      if (runStart===null || c!==prev+1){ if(runStart!==null) runs.push([runStart,prev]); runStart=c; }
      prev=c;
    }
    if (runStart!==null) runs.push([runStart,prev]);

    for (const [a,b] of runs) {
      if (b-a+1 < n) continue;
      for (let start=a; start+n-1<=b; start++){
        const windowMid = start + (n-1)/2;
        const span = (rowMaxCol-rowMinCol)/2 || 1;
        const centering = 1 - Math.abs(windowMid-rowMid)/span;
        const score = desirability*2 + centering;
        if (!best || score>best.score) {
          const cols = Array.from({length:n},(_,i)=>start+i);
          const nums = cols.map(c => r.seats.find(s=>s.col===c).num);
          best = { row:r.row, cols, nums, score, desirability, centering };
        }
      }
    }
  }
  return best;
}

function enrich(session){
  const best = bestBlock(session.rows, people);
  const totalFree = session.rows.reduce((a,r)=>a+rowFreeCount(r),0);
  const totalSeats = session.rows.reduce((a,r)=>a+rowSeatCount(r),0);
  return { ...session, best, totalFree, totalSeats, late: isLateNight(session.time), minutes: timeToMinutes(session.time) };
}

let filtered = [];
let curIdx = 0;

// Only present when a scan spans more than one cinema — lets you isolate a
// single theater or compare a subset without losing the combined ranking.
const ALL_CINEMAS = [...new Set(RAW.map(s=>s.cinema).filter(Boolean))];
let activeCinemas = new Set(ALL_CINEMAS);

function recompute(){
  const min = Number(document.getElementById('timeMin').value);
  const max = Number(document.getElementById('timeMax').value);
  filtered = RAW.map(enrich)
    .filter(s => s.minutes >= min && s.minutes <= max)
    .filter(s => !s.cinema || activeCinemas.has(s.cinema))
    .sort((a,b) => {
      if (a.late !== b.late) return a.late ? 1 : -1; // late-night always last
      const sa = a.best ? a.best.score : -99;
      const sb = b.best ? b.best.score : -99;
      return sb - sa;
    });
  if (filtered.length === 0) { curIdx = 0; return; }
  curIdx = Math.min(curIdx, filtered.length-1);
}

function fmtMinutes(m){ const h=Math.floor(m/60), mm=m%60; return String(h).padStart(2,'0')+':'+String(mm).padStart(2,'0'); }

function renderGrid(container, rows, recoSet){
  container.innerHTML='';
  for (const r of rows) {
    if (!r.seats.some(s=>s.isSeat)) continue;
    const rowEl=document.createElement('div'); rowEl.className='row';
    const label=document.createElement('div'); label.className='rowlabel'; label.textContent='R'+r.row; rowEl.appendChild(label);
    for (const seat of r.seats) {
      const el=document.createElement('div');
      if (!seat.isSeat) { el.className='seat gap'; el.style.visibility='hidden'; rowEl.appendChild(el); continue; }
      const isReco = recoSet && recoSet.row===r.row && recoSet.cols.includes(seat.col);
      el.className='seat '+(isReco?'reco':(seat.free?'free':'busy'))+(seat.handicapped?' handi':'')+(seat.loveSeat?' love':'');
      el.title='Row '+r.row+', seat '+seat.num+(seat.free?' (free)':' (taken)')+(seat.handicapped?' ♿':'')+(seat.loveSeat?' ♥':'');
      rowEl.appendChild(el);
    }
    container.appendChild(rowEl);
  }
}

function render(){
  recompute();
  document.getElementById('peopleVal').textContent = people;
  document.getElementById('navPos').textContent = filtered.length ? (curIdx+1)+' / '+filtered.length : '0 / 0';
  document.getElementById('prevBtn').disabled = curIdx<=0;
  document.getElementById('nextBtn').disabled = curIdx>=filtered.length-1;

  if (!filtered.length) {
    document.getElementById('curLabel').textContent = 'No sessions match this time range';
    document.getElementById('curStats').textContent = '';
    document.getElementById('curReco').textContent = '';
    document.getElementById('curGrid').innerHTML = '';
    document.getElementById('pinBtn').disabled = true;
    renderPinned();
    return;
  }
  document.getElementById('pinBtn').disabled = false;
  const s = filtered[curIdx];
  document.getElementById('curLabel').textContent = s.label;
  document.getElementById('curStats').textContent =
    (s.totalSeats-s.totalFree)+' / '+s.totalSeats+' taken ('+Math.round(100*(s.totalSeats-s.totalFree)/s.totalSeats)+'% full)';
  document.getElementById('curReco').textContent = s.best
    ? 'Best '+people+'-seat block: row '+s.best.row+', seats '+s.best.nums.join(', ')
    : 'No contiguous block of '+people+' free seats found in this session';
  renderGrid(document.getElementById('curGrid'), s.rows, s.best);

  const pinBtn = document.getElementById('pinBtn');
  const isPinned = pinned.includes(s.uuid);
  pinBtn.textContent = isPinned ? '★ Pinned' : '☆ Pin to compare';
  pinBtn.classList.toggle('pinned', isPinned);

  renderPinned();
}

function renderPinned(){
  const dock = document.getElementById('pinnedDock');
  dock.classList.toggle('show', pinned.length>0);
  dock.innerHTML = '';
  for (const uuid of pinned) {
    const raw = RAW.find(s=>s.uuid===uuid);
    if (!raw) continue;
    const s = enrich(raw);
    const card = document.createElement('div');
    card.className = 'pin-card';
    card.innerHTML =
      '<span class="x" data-uuid="'+uuid+'">✕</span>' +
      '<div class="label">'+s.label+'</div>' +
      '<div class="mini">'+Math.round(100*(s.totalSeats-s.totalFree)/s.totalSeats)+'% full'+
        (s.best ? ' · R'+s.best.row+' seat '+s.best.nums[0] : ' · no fit') + '</div>';
    const miniGrid = document.createElement('div'); miniGrid.className='mini-grid';
    for (const r of s.rows) {
      if (!r.seats.some(x=>x.isSeat)) continue;
      const rowEl = document.createElement('div'); rowEl.className='mini-row';
      for (const seat of r.seats) {
        const el = document.createElement('div');
        if (!seat.isSeat) { el.style.visibility='hidden'; el.className='mini-seat'; rowEl.appendChild(el); continue; }
        const isReco = s.best && s.best.row===r.row && s.best.cols.includes(seat.col);
        el.className = 'mini-seat '+(isReco?'reco':(seat.free?'free':''));
        rowEl.appendChild(el);
      }
      miniGrid.appendChild(rowEl);
    }
    card.appendChild(miniGrid);
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) return;
      const idx = filtered.findIndex(x=>x.uuid===uuid);
      if (idx>=0) { curIdx = idx; render(); }
    });
    card.querySelector('.x').addEventListener('click', (e) => {
      e.stopPropagation();
      pinned = pinned.filter(u=>u!==uuid);
      render();
    });
    dock.appendChild(card);
  }
}

document.getElementById('peopleDown').addEventListener('click', ()=>{ people=Math.max(1,people-1); render(); });
document.getElementById('peopleUp').addEventListener('click', ()=>{ people=Math.min(10,people+1); render(); });
document.getElementById('prevBtn').addEventListener('click', ()=>{ if(curIdx>0){curIdx--; render();} });
document.getElementById('nextBtn').addEventListener('click', ()=>{ if(curIdx<filtered.length-1){curIdx++; render();} });
document.getElementById('pinBtn').addEventListener('click', ()=>{
  const s = filtered[curIdx]; if(!s) return;
  if (pinned.includes(s.uuid)) pinned = pinned.filter(u=>u!==s.uuid);
  else pinned.push(s.uuid); // FIFO: newest pinned goes to the right end of the dock
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key==='ArrowLeft') document.getElementById('prevBtn').click();
  if (e.key==='ArrowRight') document.getElementById('nextBtn').click();
  if (e.key==='p' || e.key==='P') document.getElementById('pinBtn').click();
});

const allMinutes = RAW.map(s=>timeToMinutes(s.time));
const minM = Math.min(...allMinutes), maxM = Math.max(...allMinutes);
const timeMinEl = document.getElementById('timeMin'), timeMaxEl = document.getElementById('timeMax');
timeMinEl.min = 0; timeMinEl.max = 1439; timeMinEl.value = minM;
timeMaxEl.min = 0; timeMaxEl.max = 1439; timeMaxEl.value = maxM;
function updateTimeLabels(){
  document.getElementById('timeMinLabel').textContent = fmtMinutes(Number(timeMinEl.value));
  document.getElementById('timeMaxLabel').textContent = fmtMinutes(Number(timeMaxEl.value));
}
timeMinEl.addEventListener('input', ()=>{ if(+timeMinEl.value>+timeMaxEl.value) timeMinEl.value=timeMaxEl.value; updateTimeLabels(); render(); });
timeMaxEl.addEventListener('input', ()=>{ if(+timeMaxEl.value<+timeMinEl.value) timeMaxEl.value=timeMinEl.value; updateTimeLabels(); render(); });
updateTimeLabels();

if (ALL_CINEMAS.length > 1) {
  document.getElementById('cinemaFilterField').style.display = '';
  const chipsEl = document.getElementById('cinemaChips');
  for (const cinema of ALL_CINEMAS) {
    const chip = document.createElement('div');
    chip.className = 'chip active';
    chip.textContent = cinema;
    chip.addEventListener('click', () => {
      if (activeCinemas.has(cinema)) {
        if (activeCinemas.size === 1) return; // keep at least one cinema selected
        activeCinemas.delete(cinema);
      } else {
        activeCinemas.add(cinema);
      }
      chip.classList.toggle('active', activeCinemas.has(cinema));
      render();
    });
    chipsEl.appendChild(chip);
  }
}

render();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

// Lists every cinema showing this movie today, which formats each one has
// (2D, IMAX, XL Vision Atmos, ...), and which region it's in (Grande Lisboa,
// Grande Porto, Norte, Centro, Sul, Madeira, Açores) — read straight off the
// page's own region-filter checkboxes and cinema-select options, so callers
// (like the web UI) don't need to already know the exact format string or
// hardcode the region list themselves.
async function discoverCinemasAndFormats(target) {
  await sleep(1500);
  const raw = await evalJs(target, `
    (() => {
      const regionNameById = {};
      for (const cb of document.querySelectorAll('input[type=checkbox]')) {
        if (cb.id === 'all') continue;
        const label = cb.closest('label')?.textContent.trim()
          || document.querySelector('label[for="'+cb.id+'"]')?.textContent.trim();
        if (label) regionNameById[cb.id] = label;
      }
      const regionIdByCinemaName = {};
      for (const opt of document.querySelectorAll('option[data-region-id]')) {
        regionIdByCinemaName[opt.value] = opt.dataset.regionId;
      }
      const cinemas = Array.from(document.querySelectorAll('.movie-detail__sessions-list__container__theater')).map(container => {
        const name = container.dataset.name || container.querySelector('.movie-detail__sessions-list__theater-title')?.textContent.trim() || '';
        const regionId = regionIdByCinemaName[name];
        return {
          name,
          region: regionNameById[regionId] || 'Other',
          formats: Array.from(container.querySelectorAll('[data-format]')).map(el => el.dataset.format).filter((v,i,a)=>a.indexOf(v)===i),
        };
      });
      return cinemas;
    })()
  `);
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const movieUrl = args._[0];
  if (!movieUrl) {
    console.error('Usage: node scan.cjs "<movie page URL>" --cinema "Colombo" --format imax --days 5 --people 2 [--visible]');
    console.error('       node scan.cjs "<movie page URL>" --discover   (list cinemas/formats as JSON)');
    process.exit(1);
  }

  if (args.discover) {
    await ensureChrome(true);
    const target = await openTab(movieUrl);
    const cinemas = await discoverCinemasAndFormats(target);
    console.log(JSON.stringify({ cinemas }));
    closeTab(target);
    return;
  }

  const cinemas = (args.cinema || 'Colombo').split(',').map(c => c.trim()).filter(Boolean);
  const format = args.format || 'imax';
  const days = Number(args.days || 5);
  const people = Number(args.people || 1);
  const headless = !args.visible;

  console.log(`Ensuring dedicated Chrome is running (${headless ? 'headless' : 'visible'})...`);
  await ensureChrome(headless);

  console.log(`Opening ${movieUrl}`);
  const target = await openTab(movieUrl);

  console.log(`Discovering ${format} sessions at ${cinemas.join(', ')} for the next ${days} day(s)...`);
  const sessions = await discoverSessions(target, cinemas, format, days);
  console.log(`Found ${sessions.length} sessions.`);

  const results = [];
  for (const s of sessions) {
    process.stdout.write(`Scanning ${s.label}... `);
    try {
      const r = await scanSeats(target, s.uuid);
      if (r.error) { console.log('FAILED: ' + r.error); continue; }
      results.push({ label: s.label, cinema: s.cinema, date: s.date, time: s.time, uuid: s.uuid, rows: r.rows });
      console.log('OK');
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}.json`);
  const htmlPath = path.join(OUT_DIR, `${stamp}.html`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const cinemaTitle = cinemas.length > 1 ? `${cinemas.length} cinemas` : cinemas[0];
  fs.writeFileSync(htmlPath, buildHtml(`Seat scan — ${cinemaTitle} ${format.toUpperCase()}`, results, people));

  console.log(`\nWrote ${results.length} sessions to:\n  ${jsonPath}\n  ${htmlPath}`);
  execFileSync('open', [htmlPath]);
}

main().catch(e => { console.error(e); process.exit(1); });
