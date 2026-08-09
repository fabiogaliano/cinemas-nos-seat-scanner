#!/usr/bin/env node
// Local UI for scan.cjs — paste a Cinemas NOS movie URL, pick cinema/format/days/
// people from dropdowns instead of the CLI, watch progress live, get the report.
//
// No dependencies: built-in http module only, single self-contained HTML page.

const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const PORT = 5757;
const SCAN_SCRIPT = path.join(__dirname, 'scan.cjs');

const jobs = new Map(); // jobId -> { log: string[], done: bool, htmlPath: string|null, error: string|null }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleDiscover(req, res) {
  const body = JSON.parse(await readBody(req));
  const child = spawn('node', [SCAN_SCRIPT, body.movieUrl, '--discover']);
  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', code => {
    if (code !== 0) return sendJson(res, 500, { error: err || 'discover failed' });
    try {
      // last non-empty line is the JSON payload; earlier lines are the
      // "Ensuring dedicated Chrome..." progress messages scan.cjs also prints.
      const lastLine = out.trim().split('\n').filter(Boolean).pop();
      sendJson(res, 200, JSON.parse(lastLine));
    } catch (e) {
      sendJson(res, 500, { error: 'Could not parse discover output: ' + e.message });
    }
  });
}

function handleScan(req, res) {
  readBody(req).then(bodyRaw => {
    const body = JSON.parse(bodyRaw);
    const jobId = crypto.randomUUID();
    const args = [
      SCAN_SCRIPT, body.movieUrl,
      '--cinema', body.cinema,
      '--format', body.format,
      '--days', String(body.days || 5),
      '--people', String(body.people || 1),
    ];
    if (body.visible) args.push('--visible');

    const job = { log: [], done: false, htmlPath: null, error: null };
    jobs.set(jobId, job);

    const child = spawn('node', args);
    const onData = d => {
      job.log.push(d.toString());
      const m = d.toString().match(/Wrote \d+ sessions to:\n\s+\S+\n\s+(\S+\.html)/);
      if (m) job.htmlPath = m[1];
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', code => {
      job.done = true;
      if (code !== 0 && !job.htmlPath) job.error = 'Scan process exited with code ' + code;
    });

    sendJson(res, 200, { jobId });
  }).catch(e => sendJson(res, 500, { error: e.message }));
}

function handleStatus(_req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: 'unknown job' });
  sendJson(res, 200, { log: job.log.join(''), done: job.done, htmlPath: job.htmlPath, error: job.error });
}

function handleOpen(req, res) {
  readBody(req).then(bodyRaw => {
    const { path: p } = JSON.parse(bodyRaw);
    execFileSync('open', [p]);
    sendJson(res, 200, { ok: true });
  }).catch(e => sendJson(res, 500, { error: e.message }));
}

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Cinemas NOS seat scanner</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#16181c;color:#e6e6e6;margin:0;padding:32px;max-width:640px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8a8f98;font-size:13px;margin-bottom:24px}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.field label{font-size:12px;color:#8a8f98;text-transform:uppercase;letter-spacing:.04em}
input[type=text],input[type=number],select{background:#1c1f25;color:#e6e6e6;border:1px solid #33363d;border-radius:6px;padding:10px 12px;font-size:14px;width:100%}
.row{display:flex;gap:16px}
.row .field{flex:1}
.checkfield{flex-direction:row;align-items:center;gap:8px}
#cinemaList{max-height:220px;overflow-y:auto;background:#1c1f25;border:1px solid #33363d;border-radius:6px;padding:8px 12px}
#cinemaList fieldset{border:none;padding:0;margin:0 0 10px}
#cinemaList fieldset:last-child{margin-bottom:0}
#cinemaList legend{font-size:11px;color:#8a8f98;text-transform:uppercase;letter-spacing:.04em;padding:0;margin-bottom:4px}
#cinemaList label{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0;cursor:pointer}
#cinemaList label input{margin:0}
button{background:#22252b;border:1px solid #33363d;color:#e6e6e6;border-radius:6px;padding:10px 16px;font-size:14px;cursor:pointer}
button:hover{background:#2a2e36}
button:disabled{opacity:.4;cursor:default}
button.primary{background:#3ea36a;border-color:#3ea36a;color:#0e1a12;font-weight:600}
button.primary:hover{background:#4bb87a}
#discoverStatus{font-size:12px;color:#8a8f98;margin-top:4px}
#log{background:#0f1114;border:1px solid #2a2d34;border-radius:8px;padding:12px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;max-height:280px;overflow-y:auto;margin-top:16px;display:none}
#resultBar{display:none;margin-top:16px;padding:14px;background:#1c2f22;border:1px solid #3ea36a;border-radius:8px;align-items:center;justify-content:space-between}
</style></head><body>
<h1>Cinemas NOS seat scanner</h1>
<div class="sub">Paste a movie page URL, pick a cinema/format, and scan real-time seat availability across the next few days.</div>

<div class="field">
  <label>Movie page URL</label>
  <input type="text" id="movieUrl" placeholder="https://www.cinemas.nos.pt/filmes/...">
</div>
<button id="discoverBtn">Fetch cinemas &amp; formats</button>
<div id="discoverStatus"></div>

<div class="field" style="margin-top:16px">
  <label>Cinemas (pick one or more)</label>
  <div id="cinemaList"><div style="color:#8a8f98;font-size:13px">— fetch cinemas first —</div></div>
</div>
<div class="field">
  <label>Format</label>
  <select id="format" disabled></select>
</div>

<div class="row">
  <div class="field">
    <label>Days ahead</label>
    <input type="number" id="days" value="5" min="1" max="14">
  </div>
  <div class="field">
    <label>People</label>
    <input type="number" id="people" value="1" min="1" max="10">
  </div>
  <div class="field checkfield">
    <label style="text-transform:none;letter-spacing:0"><input type="checkbox" id="visible"> show browser window</label>
  </div>
</div>

<button class="primary" id="scanBtn" disabled>Scan seats</button>
<div id="log"></div>
<div id="resultBar">
  <span>✅ Scan complete</span>
  <button id="openBtn">Open report</button>
</div>

<script>
const $ = id => document.getElementById(id);
let cinemasData = [];

$('discoverBtn').addEventListener('click', async () => {
  const url = $('movieUrl').value.trim();
  if (!url) return;
  $('discoverBtn').disabled = true;
  $('discoverStatus').textContent = 'Opening movie page and reading cinemas... (~5-10s)';
  try {
    const res = await fetch('/api/discover', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ movieUrl: url }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    cinemasData = data.cinemas;
    const listEl = $('cinemaList');
    listEl.innerHTML = '';
    // Same 7 regions the site's own filter checkboxes use, in that order —
    // group the list to match rather than dumping a flat alphabetical list.
    const REGION_ORDER = ['Grande Lisboa','Grande Porto','Norte','Centro','Sul','Madeira','Açores'];
    const byRegion = new Map(REGION_ORDER.map(r => [r, []]));
    cinemasData.forEach((c,i) => {
      if (!byRegion.has(c.region)) byRegion.set(c.region, []);
      byRegion.get(c.region).push(i);
    });
    for (const [region, indices] of byRegion) {
      if (!indices.length) continue;
      const fs = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = region; fs.appendChild(legend);
      indices.forEach(i => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = i; cb.className = 'cinemaCb';
        cb.addEventListener('change', onCinemaSelectionChange);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(cinemasData[i].name.replace(/^Cinemas NOS /, '')));
        fs.appendChild(label);
      });
      listEl.appendChild(fs);
    }
    $('format').disabled = false;
    updateFormats();
    $('discoverStatus').textContent = 'Found ' + cinemasData.length + ' cinemas showing this movie.';
  } catch (e) {
    $('discoverStatus').textContent = 'Failed: ' + e.message;
  }
  $('discoverBtn').disabled = false;
});

function selectedCinemas(){
  return Array.from(document.querySelectorAll('.cinemaCb:checked')).map(cb => cinemasData[Number(cb.value)]);
}

function onCinemaSelectionChange(){
  updateFormats();
  $('scanBtn').disabled = selectedCinemas().length === 0;
}

// Format list is the union across every checked cinema — scan.cjs skips a
// cinema for a session if it doesn't actually offer the chosen format.
function updateFormats(){
  const chosen = selectedCinemas();
  const formats = [...new Set(chosen.flatMap(c => c.formats))].sort();
  const formatSel = $('format');
  const prev = formatSel.value;
  formatSel.innerHTML = '';
  formats.forEach(f => { const o=document.createElement('option'); o.value=f; o.textContent=f; formatSel.appendChild(o); });
  if (formats.includes(prev)) formatSel.value = prev;
}

$('scanBtn').addEventListener('click', async () => {
  const chosen = selectedCinemas();
  const body = {
    movieUrl: $('movieUrl').value.trim(),
    cinema: chosen.map(c => c.name.replace(/^Cinemas NOS /, '')).join(','),
    format: $('format').value,
    days: Number($('days').value),
    people: Number($('people').value),
    visible: $('visible').checked,
  };
  $('scanBtn').disabled = true;
  $('resultBar').style.display = 'none';
  const log = $('log');
  log.style.display = 'block';
  log.textContent = 'Starting scan...\\n';

  const res = await fetch('/api/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const { jobId, error } = await res.json();
  if (error) { log.textContent += 'Failed to start: ' + error; $('scanBtn').disabled = false; return; }

  const poll = setInterval(async () => {
    const r = await fetch('/api/status/' + jobId);
    const s = await r.json();
    log.textContent = s.log;
    log.scrollTop = log.scrollHeight;
    if (s.done) {
      clearInterval(poll);
      $('scanBtn').disabled = false;
      if (s.htmlPath) {
        $('resultBar').style.display = 'flex';
        $('openBtn').onclick = () => fetch('/api/open', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: s.htmlPath }) });
      }
    }
  }, 1000);
});
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE);
    } else if (req.method === 'POST' && req.url === '/api/discover') {
      await handleDiscover(req, res);
    } else if (req.method === 'POST' && req.url === '/api/scan') {
      handleScan(req, res);
    } else if (req.method === 'GET' && req.url.startsWith('/api/status/')) {
      handleStatus(req, res, req.url.slice('/api/status/'.length));
    } else if (req.method === 'POST' && req.url === '/api/open') {
      handleOpen(req, res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Cinema seat scanner UI: http://localhost:${PORT}`);
  execFileSync('open', [`http://localhost:${PORT}`]);
});
