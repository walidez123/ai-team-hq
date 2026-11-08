/* AI Team HQ — "the dispatch room" · dashboard logic (vanilla JS) */
'use strict';

const state = {
  roster: [],
  selectedAgent: 'dispatcher',
  currentRunId: null,
  es: null,
  cascadeTimer: null,
  elapsedTimer: null,
  runStartedAt: null,
  litCount: 0,
  currentReportsDir: '',
};

const $ = (sel) => document.querySelector(sel);
const crewEl = $('#roster');
const logEl = $('#log');
const wireCursor = $('#wireCursor');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const clearBtn = $('#clearBtn');
const connPill = $('#conn');
const rail = $('#rail');
const elapsedEl = $('#elapsed');
const STAGES = [...rail.querySelectorAll('.station')];
function setAssignState(mode) {
  if (mode === 'sending') { sendBtn.disabled = true; sendBtn.textContent = 'Assigning…'; }
  else if (mode === 'live') { sendBtn.disabled = true; sendBtn.textContent = 'Run in progress…'; }
  else { sendBtn.disabled = false; sendBtn.textContent = 'Assign task'; }
}

/* ---------- clock ---------- */
function tickClock() {
  const now = new Date();
  const el = $('#clock');
  el.textContent = now.toLocaleTimeString();
  el.setAttribute('datetime', now.toISOString());
}
setInterval(tickClock, 1000); tickClock();

/* ---------- log helpers ---------- */
function logLine(text, cls = 'ln-sys') {
  const p = document.createElement('div');
  p.className = `ln ${cls}`;
  const t = document.createElement('span');
  t.className = 'ln-time';
  t.textContent = new Date().toLocaleTimeString();
  p.append(t, document.createTextNode(text));
  if (wireCursor) logEl.insertBefore(p, wireCursor); else logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearEmptyState() { const e = logEl.querySelector('.wire-empty'); if (e) e.remove(); }

/* ---------- line rail lifecycle ---------- */
function railReset() {
  clearInterval(state.cascadeTimer); clearInterval(state.elapsedTimer);
  state.litCount = 0; state.runStartedAt = Date.now();
  STAGES.forEach(s => s.classList.remove('lit', 'done', 'failed'));
  state.cascadeTimer = setInterval(() => {
    if (state.litCount < STAGES.length - 1) {           // hold 'report' until the run ends
      STAGES[state.litCount].classList.add('lit');
      state.litCount += 1;
    }
  }, 1800);
  state.elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - state.runStartedAt) / 1000);
    elapsedEl.textContent = `elapsed ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}
function railFinish(ok, opts) {
  clearInterval(state.cascadeTimer); clearInterval(state.elapsedTimer);
  const interrupted = !!(opts && opts.interrupted);
  const wasLit = STAGES.map(s => s.classList.contains('lit'));
  STAGES.forEach((s, i) => {
    s.classList.remove('lit');
    if (ok || wasLit[i]) s.classList.add('done');
  });
  if (!ok && !interrupted && STAGES.length) STAGES[STAGES.length - 1].classList.add('failed');
  const total = Math.floor((Date.now() - state.runStartedAt) / 1000);
  elapsedEl.textContent = `${ok ? 'done in' : 'stopped after'} ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/* ---------- crew ---------- */
async function fetchTeam() {
  try {
    const r = await fetch('/api/team');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.roster = data.roster;
    renderAgentSelect(data.roster);
    renderBadges(data.roster);
    const busy = data.roster.filter(a => a.busy).length;
    $('#crewNote').textContent = `${data.roster.length} on the bench${busy ? ` · ${busy} on shift` : ''}`;
    setConn(busy ? 'live' : 'go', busy ? `crew working (${busy})` : 'line clear');
  } catch {
    setConn('err', 'console unreachable');
  }
}
function setConn(kind, text) {
  connPill.textContent = text;
  connPill.className = 'stamp-pill ' + (kind === 'go' ? 'stamp-go' : kind === 'live' ? 'stamp-live' : 'stamp-err');
}
function renderAgentSelect(roster) {
  const sel = $('#agentSelect');
  if (sel.options.length) return;
  for (const a of roster) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.id === 'dispatcher' ? 'dispatcher — full pipeline' : `${a.id} — ${a.blurb.split('.')[0].toLowerCase()}`;
    sel.appendChild(o);
  }
  sel.value = state.selectedAgent;
  sel.addEventListener('change', () => selectAgent(sel.value));
}
function selectAgent(id) {
  state.selectedAgent = id;
  $('#agentSelect').value = id;
  document.querySelectorAll('.badge').forEach(b => b.classList.toggle('selected', b.dataset.agent === id));
}
function renderBadges(roster) {
  crewEl.innerHTML = '';
  for (const a of roster) {
    const b = document.createElement('button');
    b.className = 'badge' + (a.id === state.selectedAgent ? ' selected' : '');
    b.dataset.agent = a.id;
    b.style.setProperty('--ink', a.color);
    b.setAttribute('aria-pressed', String(a.id === state.selectedAgent));
    const u = a.usage || { total: 0, done: 0, totalMs: 0 };
    const effort = a.effort && a.effort !== 'default' ? `<span class="bstat">effort <b>${a.effort}</b></span>` : '';
    let statLine;
    if (u.total > 0) {
      const pct = Math.round((u.done / u.total) * 100);
      statLine = `<span class="bstat"><b>${u.total}</b> run${u.total === 1 ? '' : 's'}</span><span class="bstat"><b>${pct}%</b> green</span>${effort}`;
    } else {
      statLine = `<span class="bstat dim">no runs yet</span>${effort}`;
    }
    b.innerHTML = `
      <span class="badge-hole" aria-hidden="true"></span>
      <span class="badge-stamp">${a.code}</span>
      <span class="badge-name">${a.id}</span>
      <span class="badge-duty">${a.blurb}</span>
      <span class="badge-stats" aria-label="Lifetime usage">${statLine}</span>
      <span class="badge-foot">
        <span class="badge-model">${String(a.model).replace(/^opencode\//, '')}</span>
        <span class="badge-state ${a.busy ? 'live' : ''}">${a.busy ? 'on shift' : 'standby'}</span>
      </span>
      <span class="badge-barcode" aria-hidden="true"><span class="barcode-lines"></span><span class="badge-no">№ ${a.no || '000'}</span></span>`;
    b.addEventListener('click', () => selectAgent(a.id));
    crewEl.appendChild(b);
  }
}

/* ---------- known projects ---------- */
async function loadProjects() {
  try {
    const r = await fetch('/api/projects');
    const data = await r.json();
    state.projects = data.projects || [];
    const sel = $('#projectSelect');
    const current = $('#dirInput').value.trim().toLowerCase();
    sel.innerHTML = '<option value="">known projects…</option>';
    for (const p of state.projects) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = `${p.name}${p.exists === false ? ' (missing)' : ''} — ${p.path}`;
      if (p.path.toLowerCase() === current) o.selected = true;
      sel.appendChild(o);
    }
  } catch { /* registry unavailable — text field still works */ }
}
async function registerCurrentFolder() {
  const dir = $('#dirInput').value.trim();
  if (!dir) return logLine('nothing to register — type a folder path first', 'ln-err');
  const r = await fetch('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  const data = await r.json();
  if (!r.ok) return logLine(`not registered: ${data.error || 'unknown error'} — double-check the folder exists on disk`, 'ln-err');
  logLine(`registered “${data.path}” — it will appear under known projects`, 'ln-done');
  loadProjects();
  fetchReports();
}
async function createProject() {
  const name = $('#newProjectName').value.trim();
  const targetPath = $('#newProjectPath').value.trim();
  if (!name || !targetPath) return logLine('project needs both a name and a full path — e.g. invoice-cli and C:\\work\\invoice-cli', 'ln-err');
  const r = await fetch('/api/projects/new', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, path: targetPath }),
  });
  const data = await r.json();
  if (!r.ok) return logLine(`project not created: ${data.error || 'unknown error'}`, 'ln-err');
  logLine(`${data.adopted ? 'adopted existing' : 'created'} project at ${data.path} (git: ${data.git}) — folder set as working directory`, 'ln-done');
  $('#dirInput').value = data.path;
  localStorage.setItem('hq.dir', data.path);
  $('#newProjectName').value = ''; $('#newProjectPath').value = '';
  $('#newProjectPanel').hidden = true;
  $('#toggleNewProject').setAttribute('aria-expanded', 'false');
  loadProjects();
  fetchReports();
}

/* ---------- run metrics ---------- */
function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
async function fetchMetrics() {
  try {
    const r = await fetch('/api/metrics');
    const m = await r.json();
    const el = $('#metricsNote');
    if (!m.total) { el.textContent = 'no runs on record yet — assign one above'; return; }
    const last = m.last;
    const lastBit = last
      ? `<span class="m-cell">last: <b>${last.agent}</b> <span class="${last.status === 'done' ? 'm-ok' : 'm-bad'}">${last.status === 'done' ? '✓' : '✗'} ${last.status}</span></span>`
      : '';
    el.innerHTML =
      `<span class="m-cell"><b>${m.total}</b> filed</span>` +
      `<span class="m-cell"><b>${m.successRate}%</b> green</span>` +
      `<span class="m-cell">avg <b>${fmtDuration(m.avgDurationMs)}</b></span>` +
      lastBit +
      `<span class="m-dim">reports/.metrics.jsonl</span>`;
  } catch { /* strip stays as-is */ }
}

/* ---------- reports (follows the selected project folder) ---------- */
function selectedDir() {
  return ($('#dirInput')?.value || '').trim();
}
async function fetchReports() {
  try {
    const dir = selectedDir();
    const r = await fetch('/api/reports' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    const data = await r.json();
    state.currentReportsDir = data.dir || '';
    $('#reportCount').textContent = String(data.reports.length);
    const note = $('#filedNote'); if (note) note.textContent = `${data.reports.length} on file`;
    const title = $('#reportTitle');
    const ledgerDir = $('#ledgerDir');
    if (ledgerDir) ledgerDir.textContent = state.currentReportsDir ? `${state.currentReportsDir}\\` : '';
    if (!data.reports.length) {
      if (title) title.textContent = 'Nothing here';
      const body = $('#reportBody'); if (body) body.textContent = 'Nothing filed yet.' + (state.currentReportsDir ? '\n\n' + state.currentReportsDir + '\\' : '');
    }
    const list = $('#reportList');
    list.innerHTML = '';
    if (!data.reports.length) {
      const d = document.createElement('p');
      d.className = 'panel-note';
      d.style.padding = '2px 2px 8px';
      const selected = state.currentReportsDir;
      d.textContent = selected ? `Nothing filed yet in ${selected}\\ — dispatch a task in this project.` : 'Nothing filed yet.';
      list.appendChild(d);
      return;
    }
    for (const rep of data.reports) {
      const b = document.createElement('button');
      b.className = 'slip';
      b.dataset.name = rep.name;
      b.innerHTML = `<div class="slip-name">${rep.name}</div>
        <div class="slip-meta">${new Date(rep.mtime).toLocaleString()} · ${(rep.size / 1024).toFixed(1)} KB</div>`;
      b.addEventListener('click', () => openReport(rep.name));
      list.appendChild(b);
    }
  } catch { /* leave panel as-is */ }
}
async function openReport(name) {
  $('#reportTitle').textContent = name;
  const stamp = $('#filedStamp'); if (stamp) stamp.hidden = false;
  $('#reportBody').textContent = 'Opening…';
  document.querySelectorAll('.slip').forEach(s => s.classList.toggle('selected', s.dataset.name === name));
  try {
    const dir = selectedDir();
    const r = await fetch('/api/reports/' + encodeURIComponent(name) + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    const data = await r.json();
    $('#reportBody').textContent = data.content || '(empty file)';
  } catch {
    $('#reportBody').textContent = 'This report could not be opened. Check that reports/ is readable.';
  }
}

/* ---------- dispatch + stream ---------- */
function closeStream() { if (state.es) { state.es.close(); state.es = null; } stopBtn.disabled = true; }

function renderJsonEvent(ev) {
  const e = ev.event || {};
  const text = e?.part?.text ?? e?.text ?? e?.message ?? null;
  const tool = e?.part?.tool ?? e?.tool ?? e?.name ?? null;
  const type = e?.type ?? e?.kind ?? 'event';
  if (typeof text === 'string' && text.trim()) return logLine(text.trim(), 'ln-text');
  if (tool) return logLine(`[tool] ${tool}`, 'ln-tool');
  const raw = JSON.stringify(e);
  logLine(`${type} ${raw.length > 200 ? raw.slice(0, 200) + '…' : raw}`, 'ln-sys');
}
function handleEvent(ev) {
  clearEmptyState();
  if (ev.kind === 'status') {
    if (ev.status === 'running') return logLine(`run started${ev.dir ? ' in ' + ev.dir : ''}`, 'ln-sys');
    logEl.classList.remove('running');
    if (ev.status === 'done') {
      logLine('✓ run finished', 'ln-done');
      railFinish(true);
    } else if (ev.status === 'stopped') {
      logLine('■ run stopped', 'ln-err');
      railFinish(false, { interrupted: true });
    } else {
      logLine(`✗ run ${ev.status} (exit ${ev.exitCode ?? '?'})`, 'ln-err');
      railFinish(false);
    }
    closeStream(); setAssignState('idle'); state.currentRunId = null; fetchTeam(); fetchReports(); fetchMetrics();
    if (shiftsOn) fetchJournal();
    return;
  }
  if (ev.kind === 'json') return renderJsonEvent(ev);
  if (ev.kind === 'raw') return logLine(ev.text, ev.stream === 'stderr' ? 'ln-err' : 'ln-text');
}

async function fetchLedger() { /* run ledger renders here — filled in with the ledger view */ }

function watchRun(id) {
  closeStream();
  state.currentRunId = id;
  logEl.classList.add('running');
  stopBtn.disabled = false;
  state.es = new EventSource('/api/stream?run=' + encodeURIComponent(id));
  state.es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch { logLine(m.data, 'ln-sys'); } };
  state.es.onerror = () => { logEl.classList.remove('running'); closeStream(); state.currentRunId = null; setAssignState('idle'); fetchLedger(); };
}

async function dispatchTask(task, dir) {
  if (state.currentRunId) return logLine('a run is already streaming — stop it first or open the run ledger', 'ln-err');
  clearEmptyState();
  logLine(`assigning to @${state.selectedAgent}: “${task}”`, 'ln-sys');
  setAssignState('sending');
  railReset();
  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, agent: state.selectedAgent, dir }),
    });
    const data = await r.json();
    if (!r.ok) { logLine(`not assigned: ${data.error || 'unknown error'} — check the project path and try again`, 'ln-err'); railFinish(false); setAssignState('idle'); return; }
    watchRun(data.id);
    setAssignState('live');
  } catch (e) {
    logLine(`not assigned: ${e.message} — check the project path and try again`, 'ln-err');
    railFinish(false);
    setAssignState('idle');
  }
}

/* ---------- wire up ---------- */
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const task = $('#taskInput').value.trim();
  if (!task) return;
  const dir = $('#dirInput').value.trim();
  $('#taskInput').value = '';
  dispatchTask(task, dir);
});
stopBtn.addEventListener('click', async () => {
  if (!state.currentRunId) return;
  await fetch(`/api/runs/${encodeURIComponent(state.currentRunId)}/stop`, { method: 'POST' });
  logLine('stop requested — the crew will halt at the next safe point', 'ln-err');
});
clearBtn.addEventListener('click', () => {
  const active = !!(state.es || state.currentRunId);
  if (active && !confirm('A run is streaming. Clear the log display only?')) return;
  const stale = logEl.querySelectorAll(':scope > .ln, :scope > .wire-empty');
  stale.forEach(n => n.remove());
  logEl.scrollTop = 0;
  if (!active) {
    const empty = document.createElement('p');
    empty.className = 'wire-empty';
    empty.textContent = 'Quiet on the wire. Assign a task — the crew plans it, builds it, tests it, reviews it and files a report, in that order.';
    if (wireCursor) logEl.insertBefore(empty, wireCursor); else logEl.appendChild(empty);
  }
});
$('#refreshReports').addEventListener('click', fetchReports);
$('#projectSelect').addEventListener('change', (e) => {
  if (!e.target.value) return;
  $('#dirInput').value = e.target.value;
  localStorage.setItem('hq.dir', e.target.value);
  fetchReports();
  if (shiftsOn) fetchJournal();
});
$('#dirInput').addEventListener('change', () => {
  localStorage.setItem('hq.dir', $('#dirInput').value.trim());
  fetchReports();
});
$('#registerProjectBtn').addEventListener('click', registerCurrentFolder);
$('#toggleNewProject').addEventListener('click', () => {
  const panel = $('#newProjectPanel');
  panel.hidden = !panel.hidden;
  $('#toggleNewProject').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) $('#newProjectName').focus();
});
$('#createProjectBtn').addEventListener('click', createProject);
$('#dirInput').value = localStorage.getItem('hq.dir') || '';

fetchTeam();
fetchReports();
loadProjects();
fetchMetrics();
setInterval(fetchTeam, 5000);
setInterval(fetchReports, 10000);
setInterval(fetchMetrics, 15000);
setInterval(() => { if (shiftsOn) fetchJournal(); }, 15000);

/* ---------- shift log ---------- */
const shiftViewBtn = $('#shiftViewBtn');
const shiftView = $('#shiftView');
let shiftsOn = false;

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function renderShiftView(data) {
  shiftView.innerHTML = '';
  for (const a of data.agents) {
    const row = el('div', 'shift-row');
    const head = el('div', 'shift-head');
    const code = el('span', 'shift-code', a.code); code.style.setProperty('--ink', a.color);
    head.append(code, el('span', 'shift-name', a.id), el('span', 'shift-count', `${a.entries.length} entr${a.entries.length === 1 ? 'y' : 'ies'}`));
    row.appendChild(head);
    if (!a.entries.length) {
      row.appendChild(el('div', 'shift-empty', 'No entries yet — employees write one line each as they finish work.'));
    } else {
      const list = el('div', 'shift-entries');
      for (const e of a.entries.slice().reverse()) {
        const line = el('div', 'shift-entry');
        const dot = el('span', `shift-dot ${e.status || 'done'}`);
        const time = el('span', 'shift-time', e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--');
        line.append(dot, time, el('span', 'shift-summary', e.summary || `(${e.status})`));
        list.appendChild(line);
      }
      row.appendChild(list);
    }
    shiftView.appendChild(row);
  }
}
async function fetchJournalData() {
  const dir = $('#dirInput').value.trim();
  const r = await fetch('/api/journal' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
  return r.json();
}
async function fetchJournal() {
  try { renderShiftView(await fetchJournalData()); } catch { /* leave the panel as-is */ }
}
shiftViewBtn.addEventListener('click', () => {
  shiftsOn = !shiftsOn;
  shiftViewBtn.setAttribute('aria-pressed', String(shiftsOn));
  shiftViewBtn.textContent = shiftsOn ? 'live wire' : 'shift log';
  $('#log').hidden = shiftsOn;
  shiftView.hidden = !shiftsOn;
  if (shiftsOn) fetchJournal();
});

/* ---------- stage sheet (rail drill-down) ---------- */
const STAGE_DEFS = {
  intake: { owners: ['dispatcher'] },
  plan:   { owners: ['architect'] },
  build:  { owners: ['backend', 'frontend'] },
  test:   { owners: ['qa'] },
  review: { owners: ['reviewer'] },
  report: { owners: ['reporter'] },
};
const stageSheet = $('#stageSheet');
const stageTitle = $('#stageTitle');
const stageBody = $('#stageSheetBody');
let stagePrevFocus = null;

function ownerById(id) { return (state.roster || []).find(a => a.id === id); }
function closeStageSheet() {
  stageSheet.hidden = true;
  if (stagePrevFocus && stagePrevFocus.focus) stagePrevFocus.focus();
}
function journalSummaryFor(owner, e) {
  return owner + ': ' + (e.summary || '');
}

async function openStageSheet(key) {
  const def = STAGE_DEFS[key]; if (!def) return;
  stageTitle.textContent = key;
  stageBody.innerHTML = '';

  // who owns this station
  const secOwners = el('div', 'stage-section');
  secOwners.appendChild(el('h3', null, 'handled by'));
  const ownersWrap = el('div', 'stage-owners');
  for (const id of def.owners) {
    const a = ownerById(id);
    const chip = el('div', 'owner-chip');
    const code = el('span', 'owner-code', (a && a.code) || id.slice(0, 2).toUpperCase());
    code.style.setProperty('--ink', (a && a.color) || '#d97757');
    const meta = el('div');
    meta.append(el('div', 'owner-name', id), el('div', 'owner-model', String((a && a.model) || '').replace(/^opencode\//, '')));
    chip.append(code, meta);
    ownersWrap.appendChild(chip);
  }
  secOwners.appendChild(ownersWrap);
  stageBody.appendChild(secOwners);

  // intake also shows what the last run was
  if (key === 'intake') {
    const sec = el('div', 'stage-section');
    sec.appendChild(el('h3', null, 'last run in this project'));
    const box = el('div', 'stage-run');
    try {
      const m = await fetch('/api/metrics').then(r => r.json());
      if (m && m.last) {
        box.append('dispatched to ', el('b', null, m.last.agent), ' · ');
        const s = el('span', m.last.status === 'done' ? 'run-ok' : 'run-bad', m.last.status);
        box.append(s, el('br'), document.createTextNode(m.last.task || '—'));
      } else {
        box.textContent = 'No runs on record — assign the crew a task first.';
      }
    } catch { box.textContent = 'Metrics unavailable.'; }
    sec.appendChild(box);
    stageBody.appendChild(sec);
  }

  // what the shift log holds for this station
  const secJ = el('div', 'stage-section');
  secJ.appendChild(el('h3', null, 'from the shift log'));
  let data = null;
  try { data = await fetchJournalData(); } catch { /* fall through to empty state */ }
  const entries = [];
  for (const id of def.owners) {
    const a = data && data.agents.find(x => x.id === id);
    if (a) for (const e of a.entries) entries.push({ ...e, owner: id });
  }
  entries.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')));
  if (!entries.length) {
    secJ.appendChild(el('div', 'stage-empty', 'Nothing filed at this station yet. Journal lines land here when the crew finishes work — dispatch a task in this project and watch it.'));
  } else {
    for (const e of entries.slice(-6)) {
      const row = el('div', 'stage-entry');
      const dot = el('span', `stage-dot ${e.status || 'done'}`);
      const time = el('span', 'stage-entry-time', e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--');
      row.append(dot, time, el('div', 'stage-entry-summary', journalSummaryFor(e.owner, e)));
      secJ.appendChild(row);
    }
  }
  stageBody.appendChild(secJ);

  stagePrevFocus = document.activeElement;
  stageSheet.hidden = false;
  $('#closeStageSheet').focus();
}

document.querySelectorAll('.station').forEach(b => b.addEventListener('click', () => openStageSheet(b.dataset.stage)));
$('#closeStageSheet').addEventListener('click', closeStageSheet);

/* ---------- crew setup (per-employee model) ---------- */
const settingsOverlay = $('#settingsOverlay');
const settingsBody = $('#settingsBody');
let settingsPrevFocus = null;

function openSettings() {
  settingsPrevFocus = document.activeElement;
  settingsOverlay.hidden = false;
  $('#closeSettings').focus();
  loadSettings();
}
function closeSettings() {
  settingsOverlay.hidden = true;
  if (settingsPrevFocus && settingsPrevFocus.focus) settingsPrevFocus.focus();
}
$('#openSettings').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', closeSettings);
$('#settingsDone').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target.hasAttribute('data-settings-close')) closeSettings(); });

async function loadSettings() {
  settingsBody.innerHTML = '<p class="panel-note" style="padding:10px 2px">Reading the roster…</p>';
  try {
    const r = await fetch('/api/agents/settings');
    const data = await r.json();
    renderVitals(data.consoleVitals);
    renderSettings(data);
  } catch {
    settingsBody.innerHTML = '<p class="panel-note" style="padding:10px 2px">Could not read the agent files.</p>';
  }
}

function renderVitals(v) {
  const elx = $('#settingsVitals');
  if (!v) { elx.innerHTML = ''; return; }
  const chips = [
    ['sessions', v.sessions], ['subagents', v.subagents], ['prompts', v.prompts],
    ['steps', v.steps], ['tokens', v.tokens], ['tool success', v.toolSuccess],
  ].filter(([, n]) => n);
  elx.innerHTML = chips.map(([k, n]) => `<span class="vital-chip"><b>${n}</b> ${k}</span>`).join('') +
    '<span class="vital-chip" title="The free lane does not publish remaining allowance">free quota: <b>remaining — not published</b></span>';
}

function renderSettings(data) {
  settingsBody.innerHTML = '';
  const free = new Set(data.freeOnly || []);
  for (const a of data.agents) {
    const row = el('div', 'setting-row');
    const code = el('span', 'setting-code', a.code);
    code.style.setProperty('--ink', a.color);
    const meta = el('div');
    meta.append(el('div', 'setting-name', a.id), el('div', 'setting-blurb', a.blurb));
    const u = a.usage || { total: 0, done: 0 };
    const usage = el('div', 'setting-usage');
    if (u.total > 0) {
      const pct = Math.round((u.done / u.total) * 100);
      usage.innerHTML = `<b>${u.total}</b> run${u.total === 1 ? '' : 's'} · <b>${pct}%</b> green`;
    } else {
      usage.textContent = 'no runs on record';
    }
    meta.appendChild(usage);

    const save = el('span', 'setting-save', '');
    let savedTimer = null;
    const flash = (text, ok) => {
      save.textContent = ok ? text : String(text).slice(0, 90);
      save.classList.toggle('err', !ok);
      save.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => save.classList.remove('show'), 3500);
    };
    const post = async (field, value) => {
      save.textContent = 'saving…';
      save.classList.remove('err');
      save.classList.add('show');
      try {
        const r = await fetch('/api/agents/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: a.id, [field]: value }),
        });
        const out = await r.json();
        if (r.ok) flash('saved ✓', true); else flash(out.error || 'failed', false);
      } catch (e) { flash(String(e.message || e), false); }
    };

    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Model for ${a.id}`);
    const current = a.effectiveModel || '';
    for (const m of data.catalog) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m.replace(/^opencode\//, '') + (free.has(m) ? ' · free' : '');
      if (m === current) o.selected = true;
      sel.appendChild(o);
    }
    if (current && !data.catalog.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current.replace(/^opencode\//, '') + ' · current';
      o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.addEventListener('change', () => post('model', sel.value));

    const effort = document.createElement('select');
    effort.className = 'setting-effort';
    effort.setAttribute('aria-label', `Reasoning effort for ${a.id}`);
    for (const lvl of ['default', 'low', 'medium', 'high']) {
      const o = document.createElement('option');
      o.value = lvl;
      o.textContent = lvl === 'default' ? 'effort · default' : `effort · ${lvl}`;
      if ((a.effort || 'default') === lvl) o.selected = true;
      effort.appendChild(o);
    }
    effort.addEventListener('change', () => post('effort', effort.value === 'default' ? '' : effort.value));

    row.append(code, meta, sel, effort, save);
    settingsBody.appendChild(row);
  }
}

const distributeFreeBtn = $('#distributeFree');
const distributeNote = $('#distributeNote');
async function distributeFree() {
  distributeFreeBtn.disabled = true;
  distributeNote.hidden = false;
  distributeNote.textContent = 'spreading the free catalog…';
  try {
    const r = await fetch('/api/agents/distribute', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) { distributeNote.textContent = `not spread: ${data.error || 'unknown error'}`; return; }
    const lines = Object.entries(data.assignment).map(([id, m]) => `${id} → ${m.replace(/^opencode\//, '')}`);
    distributeNote.textContent = `Spread ${data.totalFree} free models across the bench: ${lines.join(' · ')}${data.spare.length ? ` — spare: ${data.spare.map(m => m.replace(/^opencode\//, '')).join(', ')}` : ''}`;
    loadSettings();
  } catch (e) {
    distributeNote.textContent = `not spread: ${String(e.message || e)}`;
  } finally {
    distributeFreeBtn.disabled = false;
  }
}
distributeFreeBtn.addEventListener('click', distributeFree);

/* ---------- model routing preference ---------- */
const routingStaticBtn = $('#routingStatic');
const routingDynamicBtn = $('#routingDynamic');
function setRoutingUI(value) {
  routingStaticBtn.setAttribute('aria-pressed', String(value === 'static'));
  routingDynamicBtn.setAttribute('aria-pressed', String(value === 'dynamic'));
}
async function loadPreferences() {
  try {
    const r = await fetch('/api/preferences');
    const p = await r.json();
    setRoutingUI(p.modelRouting);
  } catch { /* leave the toggle as-is */ }
}
async function setRouting(value) {
  try {
    const r = await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelRouting: value }),
    });
    const p = await r.json();
    if (r.ok) setRoutingUI(p.modelRouting);
  } catch { /* leave the toggle as-is */ }
}
routingStaticBtn.addEventListener('click', () => setRouting('static'));
routingDynamicBtn.addEventListener('click', () => setRouting('dynamic'));
loadPreferences();

/* ---------- field guide ---------- */
const guideOverlay = $('#guideOverlay');
const openGuideBtn = $('#openGuide');
const closeGuideBtn = $('#closeGuide');
const guideGotIt = $('#guideGotIt');
let guidePrevFocus = null;
function openGuide() {
  guidePrevFocus = document.activeElement;
  guideOverlay.hidden = false;
  closeGuideBtn.focus();
}
function closeGuide() {
  guideOverlay.hidden = true;
  localStorage.setItem('hq.guideSeen', '1');
  if (guidePrevFocus && guidePrevFocus.focus) guidePrevFocus.focus();
}
openGuideBtn.addEventListener('click', openGuide);
closeGuideBtn.addEventListener('click', closeGuide);
guideGotIt.addEventListener('click', closeGuide);
guideOverlay.addEventListener('click', (e) => { if (e.target.hasAttribute('data-guide-close')) closeGuide(); });

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
  if (e.key === 'Escape') { if (!settingsOverlay.hidden) { closeSettings(); return; } if (!stageSheet.hidden) { closeStageSheet(); return; } if (!guideOverlay.hidden) closeGuide(); return; }
  if (typing) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest && e.target.closest('#taskForm')) {
      e.preventDefault();
      $('#taskForm').requestSubmit();
    }
    return;
  }
  if (e.key === '/') { e.preventDefault(); $('#taskInput').focus(); }
  else if (e.key === '?') { e.preventDefault(); guideOverlay.hidden ? openGuide() : closeGuide(); }
});
if (!localStorage.getItem('hq.guideSeen')) openGuide();
