/* AI Team HQ — "the dispatch room" · dashboard logic (vanilla JS) */
'use strict';

const state = {
  roster: [],
  engine: 'agy',
  selectedAgent: 'dispatcher',
  currentRunId: null,
  es: null,
  elapsedTimer: null,
  runStartedAt: null,
  currentReportsDir: '',
  currentReportContent: '',
  reportViewMode: 'rendered', // 'rendered' | 'raw'
  autoScroll: true,
  wireFilter: 'all',
  projects: [],
};

const $ = (sel) => document.querySelector(sel);
const crewEl = $('#roster');
const logEl = $('#log');
const wireCursor = $('#wireCursor');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const detachBtn = $('#detachBtn');
const clearBtn = $('#clearBtn');
const connPill = $('#conn');
const engineBadge = $('#engineBadge');
const rail = $('#rail');
const elapsedEl = $('#elapsed');
const scrollFollowBtn = $('#scrollFollowBtn');
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
  if (!el) return;
  el.textContent = now.toLocaleTimeString();
  el.setAttribute('datetime', now.toISOString());
}
setInterval(tickClock, 1000); tickClock();

/* ---------- scroll-lock & log helpers ---------- */
function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 42;
}

logEl.addEventListener('scroll', () => {
  state.autoScroll = isNearBottom(logEl);
  if (scrollFollowBtn) scrollFollowBtn.hidden = state.autoScroll;
});

if (scrollFollowBtn) {
  scrollFollowBtn.addEventListener('click', () => {
    state.autoScroll = true;
    scrollFollowBtn.hidden = true;
    logEl.scrollTop = logEl.scrollHeight;
  });
}

function logLine(text, cls = 'ln-sys', timeIso = null) {
  const p = document.createElement('div');
  p.className = `ln ${cls}`;
  const t = document.createElement('span');
  t.className = 'ln-time';
  const d = timeIso ? new Date(timeIso) : new Date();
  t.textContent = Number.isNaN(d.getTime()) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();
  p.append(t, document.createTextNode(text));
  if (wireCursor) logEl.insertBefore(p, wireCursor); else logEl.appendChild(p);
  if (state.autoScroll) {
    logEl.scrollTop = logEl.scrollHeight;
  } else if (scrollFollowBtn) {
    scrollFollowBtn.hidden = false;
  }
}

function clearEmptyState() {
  const e = logEl.querySelector('.wire-empty');
  if (e) e.remove();
}

/* ---------- wire filter pills ---------- */
document.querySelectorAll('.wf-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    state.wireFilter = btn.dataset.filter || 'all';
    document.querySelectorAll('.wf-chip').forEach(b => b.classList.toggle('active', b === btn));
    if (state.wireFilter === 'all') logEl.removeAttribute('data-filter');
    else logEl.setAttribute('data-filter', state.wireFilter);
  });
});

/* ---------- real event-driven line rail ---------- */
function startElapsedTimer(startedAtIso) {
  clearInterval(state.elapsedTimer);
  const parsed = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
  state.runStartedAt = Number.isNaN(parsed) ? Date.now() : parsed;
  const update = () => {
    const s = Math.max(0, Math.floor((Date.now() - state.runStartedAt) / 1000));
    elapsedEl.textContent = `elapsed ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  update();
  state.elapsedTimer = setInterval(update, 1000);
}

function applyRailStages(stages) {
  if (!stages || typeof stages !== 'object') return;
  for (const s of STAGES) {
    const key = s.dataset.stage;
    const st = stages[key] || 'idle';
    s.classList.remove('lit', 'done', 'failed');
    if (st === 'lit') s.classList.add('lit');
    else if (st === 'done') s.classList.add('done');
    else if (st === 'failed') s.classList.add('failed');
  }
}

function railReset(agent = 'dispatcher', startedAtIso = null) {
  STAGES.forEach(s => s.classList.remove('lit', 'done', 'failed'));
  const initial = { intake: 'lit', plan: 'idle', build: 'idle', test: 'idle', review: 'idle', report: 'idle' };
  const agentStageMap = { architect: 'plan', backend: 'build', frontend: 'build', qa: 'test', reviewer: 'review', reporter: 'report', explainer: 'report' };
  if (agent !== 'dispatcher' && agentStageMap[agent]) {
    initial.intake = 'done';
    initial[agentStageMap[agent]] = 'lit';
  }
  applyRailStages(initial);
  startElapsedTimer(startedAtIso);
}

function railFinish(ok, opts) {
  clearInterval(state.elapsedTimer);
  const interrupted = !!(opts && opts.interrupted);
  if (opts && opts.stages) {
    applyRailStages(opts.stages);
  } else {
    const wasLit = STAGES.map(s => s.classList.contains('lit') || s.classList.contains('done'));
    STAGES.forEach((s, i) => {
      s.classList.remove('lit');
      if (ok || wasLit[i]) s.classList.add('done');
    });
    if (!ok && !interrupted && STAGES.length) {
      STAGES[STAGES.length - 1].classList.remove('done');
      STAGES[STAGES.length - 1].classList.add('failed');
    }
  }
  const total = Math.max(0, Math.floor((Date.now() - (state.runStartedAt || Date.now())) / 1000));
  elapsedEl.textContent = `${ok ? 'done in' : 'stopped after'} ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/* ---------- crew ---------- */
function selectedDir() {
  return ($('#dirInput')?.value || '').trim();
}

async function fetchTeam() {
  try {
    const dir = selectedDir();
    const r = await fetch('/api/team' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.roster = data.roster;
    state.engine = data.engine || 'agy';
    if (engineBadge) {
      engineBadge.textContent = state.engine === 'agy' ? 'agy · antigravity' : 'opencode · cli';
    }
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
      <span class="badge-stats" aria-label="Project usage">${statLine}</span>
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
  } catch { /* registry unavailable */ }
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
  refreshProjectContext();
}

async function unregisterSelectedFolder() {
  const dir = $('#dirInput').value.trim() || $('#projectSelect').value.trim();
  if (!dir) return logLine('select a project or type a registered folder path to unregister', 'ln-err');
  const r = await fetch('/api/projects', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: dir }),
  });
  if (!r.ok) return logLine('could not unregister folder', 'ln-err');
  logLine(`unregistered “${dir}” from known projects`, 'ln-sys');
  if ($('#dirInput').value.trim().toLowerCase() === dir.toLowerCase()) {
    $('#dirInput').value = '';
    localStorage.removeItem('hq.dir');
  }
  loadProjects();
  refreshProjectContext();
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
  refreshProjectContext();
}

/* ---------- git status inspector ---------- */
async function fetchGitStatus() {
  const pill = $('#gitPill');
  if (!pill) return;
  try {
    const dir = selectedDir();
    const r = await fetch('/api/git-status' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    const g = await r.json();
    if (!g.isRepo) {
      pill.textContent = '⎇ not a git repo';
      pill.className = 'git-pill';
      return;
    }
    pill.textContent = `⎇ ${g.branch} · ${g.clean ? 'clean' : `${g.changedCount} modified`}`;
    pill.className = `git-pill ${g.clean ? 'clean' : 'dirty'}`;
    const branchLbl = $('#gitBranchLabel');
    if (branchLbl) branchLbl.textContent = g.branch || 'HEAD';

    const filesList = $('#gitFilesList');
    if (filesList) {
      filesList.innerHTML = '';
      if (!g.changedFiles || !g.changedFiles.length) {
        filesList.textContent = 'Working tree clean — ready for branch or merge.';
      } else {
        for (const f of g.changedFiles) {
          const item = el('div', 'git-item');
          item.append(el('span', 'git-badge', f.status || 'M'), el('span', null, f.file));
          filesList.appendChild(item);
        }
      }
    }

    const commitsList = $('#gitCommitsList');
    if (commitsList) {
      commitsList.innerHTML = '';
      if (!g.commits || !g.commits.length) {
        commitsList.textContent = 'No commits on this branch yet.';
      } else {
        for (const c of g.commits) {
          const item = el('div', 'git-item');
          item.append(el('span', 'git-hash', c.hash), el('span', null, c.subject));
          commitsList.appendChild(item);
        }
      }
    }
  } catch {
    pill.textContent = '⎇ git unavailable';
  }
}

const gitPill = $('#gitPill');
const gitPanel = $('#gitPanel');
if (gitPill && gitPanel) {
  gitPill.addEventListener('click', () => {
    gitPanel.hidden = !gitPanel.hidden;
    if (!gitPanel.hidden) fetchGitStatus();
  });
}
if ($('#closeGitPanel')) {
  $('#closeGitPanel').addEventListener('click', () => { gitPanel.hidden = true; });
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
    const dir = selectedDir();
    const r = await fetch('/api/metrics' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    const m = await r.json();
    const elx = $('#metricsNote');
    if (!m.total) {
      elx.innerHTML = dir
        ? `no runs in this project yet (${m.globalTotal || 0} global) — assign one above`
        : 'no runs on record yet — assign one above';
      return;
    }
    const last = m.last;
    const lastBit = last
      ? `<span class="m-cell">last: <b>${last.agent}</b> <span class="${last.status === 'done' ? 'm-ok' : 'm-bad'}">${last.status === 'done' ? '✓' : '✗'} ${last.status}</span></span>`
      : '';
    const scopeNote = (dir && m.globalTotal !== m.total) ? ` <span class="m-dim">(${m.globalTotal} total)</span>` : '';
    elx.innerHTML =
      `<span class="m-cell"><b>${m.total}</b> filed${scopeNote}</span>` +
      `<span class="m-cell"><b>${m.successRate}%</b> green</span>` +
      `<span class="m-cell">avg <b>${fmtDuration(m.avgDurationMs)}</b></span>` +
      lastBit;
  } catch { /* strip stays as-is */ }
}

/* ---------- safe zero-dep markdown renderer for reports ---------- */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMd(line) {
  let s = escapeHtml(line);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeLines = [];
  let inList = false;
  let inTable = false;
  let tableHeaderDone = false;

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; tableHeaderDone = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith('```')) {
      closeList(); closeTable();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      closeList(); closeTable();
      continue;
    }

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList();
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue; // separator row
      if (!inTable) {
        out.push('<table><thead><tr>' + cells.map(c => `<th>${formatInlineMd(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
        tableHeaderDone = true;
      } else {
        out.push('<tr>' + cells.map(c => `<td>${formatInlineMd(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }
    closeTable();

    // Headings
    const hm = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${formatInlineMd(hm[2])}</h${lvl}>`);
      continue;
    }

    // List item
    const lm = trimmed.match(/^[-*]\s+(.+)$/);
    if (lm) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${formatInlineMd(lm[1])}</li>`);
      continue;
    }
    closeList();

    out.push(`<p>${formatInlineMd(trimmed)}</p>`);
  }
  closeList(); closeTable();
  if (inCode) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function updateReportDisplay() {
  const preEl = $('#reportBody');
  const renEl = $('#reportRendered');
  const toggleBtn = $('#toggleReportMode');
  const copyBtn = $('#copyReportBtn');
  if (!state.currentReportContent) {
    if (renEl) renEl.hidden = true;
    if (preEl) preEl.hidden = false;
    if (toggleBtn) toggleBtn.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    return;
  }
  if (toggleBtn) {
    toggleBtn.hidden = false;
    toggleBtn.textContent = state.reportViewMode === 'rendered' ? 'Raw MD' : 'Rendered';
  }
  if (copyBtn) copyBtn.hidden = false;
  if (state.reportViewMode === 'rendered' && renEl) {
    renEl.innerHTML = renderMarkdown(state.currentReportContent);
    renEl.hidden = false;
    preEl.hidden = true;
  } else {
    preEl.textContent = state.currentReportContent;
    preEl.hidden = false;
    if (renEl) renEl.hidden = true;
  }
}

if ($('#toggleReportMode')) {
  $('#toggleReportMode').addEventListener('click', () => {
    state.reportViewMode = state.reportViewMode === 'rendered' ? 'raw' : 'rendered';
    updateReportDisplay();
  });
}

if ($('#copyReportBtn')) {
  $('#copyReportBtn').addEventListener('click', async () => {
    if (!state.currentReportContent) return;
    try {
      await navigator.clipboard.writeText(state.currentReportContent);
      $('#copyReportBtn').textContent = 'Copied ✓';
      setTimeout(() => { $('#copyReportBtn').textContent = 'Copy'; }, 2000);
    } catch { /* ignore */ }
  });
}

/* ---------- reports (follows the selected project folder) ---------- */
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
      state.currentReportContent = '';
      updateReportDisplay();
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
    state.currentReportContent = data.content || '(empty file)';
    updateReportDisplay();
  } catch {
    state.currentReportContent = '';
    updateReportDisplay();
    $('#reportBody').textContent = 'This report could not be opened. Check that reports/ is readable.';
  }
}

/* ---------- dispatch + stream ---------- */
const pausePhaseBtn = $('#pausePhaseBtn');

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
  stopBtn.disabled = true;
  if (detachBtn) detachBtn.hidden = true;
  if (pausePhaseBtn) {
    pausePhaseBtn.hidden = true;
    pausePhaseBtn.disabled = false;
    pausePhaseBtn.textContent = '⏸ Pause phase';
  }
}

function detachCurrentRun() {
  if (!state.currentRunId) return;
  logLine(`detached viewer from ${state.currentRunId} (run continues in background — re-attach via run ledger)`, 'ln-sys');
  closeStream();
  clearInterval(state.elapsedTimer);
  state.currentRunId = null;
  logEl.classList.remove('running');
  setAssignState('idle');
  fetchLedger();
}

if (detachBtn) {
  detachBtn.addEventListener('click', detachCurrentRun);
}

if (pausePhaseBtn) {
  pausePhaseBtn.addEventListener('click', async () => {
    if (!state.currentRunId) return;
    pausePhaseBtn.disabled = true;
    pausePhaseBtn.textContent = '⏸ Pausing after phase…';
    try {
      await fetch(`/api/runs/${encodeURIComponent(state.currentRunId)}/pause`, { method: 'POST' });
    } catch { /* ignore */ }
  });
}

function renderJsonEvent(ev) {
  const e = ev.event || {};
  const ts = ev.ts || null;
  const type = String(e.event ?? e.type ?? e.kind ?? '').toLowerCase();

  // Thinking / reasoning stream
  const thought = e.thought ?? (type === 'thought' ? (e.message || e.text || e.content) : null);
  if (typeof thought === 'string' && thought.trim()) {
    return logLine(`💭 ${thought.trim()}`, 'ln-thought', ts);
  }

  // Tool invocation
  const tool = e?.part?.tool ?? e?.tool ?? (type === 'tool_use' || type === 'tool_call' ? (e.name || e.tool) : null);
  if (tool) {
    const input = e.input || e.args || e?.part?.input || null;
    const argPreview = input ? ' ' + JSON.stringify(input).slice(0, 120) : '';
    return logLine(`[tool] ${tool}${argPreview}`, 'ln-tool', ts);
  }

  // Result / assistant output text
  const text = e?.part?.text ?? e?.output ?? e?.text ?? e?.message ?? e?.content ?? null;
  if (typeof text === 'string' && text.trim()) {
    return logLine(text.trim(), 'ln-text', ts);
  }

  // Start event
  if (type === 'start') {
    return logLine(`session initialized (${e.agent || e.model || 'agent ready'})`, 'ln-sys', ts);
  }

  const raw = JSON.stringify(e);
  logLine(`${type || 'event'} ${raw.length > 200 ? raw.slice(0, 200) + '…' : raw}`, 'ln-sys', ts);
}

function handleEvent(ev) {
  clearEmptyState();
  const ts = ev.ts || null;

  if (ev.kind === 'stage') {
    if (ev.stages) applyRailStages(ev.stages);
    logLine(`→ station [${ev.stage}] ${ev.status === 'done' ? 'completed ✓' : 'active'} (${ev.agent || ''})`, 'ln-stage', ts);
    return;
  }

  if (ev.kind === 'phase') {
    if (ev.memory) {
      state.memory = ev.memory;
      renderMemoryBar(ev.memory);
    }
    const shortModel = String(ev.model || '').replace(/^opencode\//, '');
    if (ev.status === 'running') {
      logLine(`◈ Phase ${(ev.index ?? 0) + 1}/${ev.total || 5} [${ev.label}] started — @${ev.agent} on ${ev.engine || 'cli'}/${shortModel}`, 'ln-stage', ts);
    } else if (ev.status === 'done') {
      logLine(`✓ Phase [${ev.label}] completed & saved to project memory${ev.nextLabel ? ' → advancing to ' + ev.nextLabel : ''}`, 'ln-done', ts);
    } else if (ev.status === 'paused') {
      logLine(`⏸ Phase [${ev.label}] completed & checkpointed. Paused before [${ev.nextLabel || 'next phase'}] — you may switch models/engines and click ▶ Resume / Next Phase.`, 'ln-stage', ts);
    } else if (ev.status === 'failed') {
      logLine(`✗ Phase [${ev.label}] failed (${ev.error || 'error'}) — state saved in memory. Switch models/engines and click ▶ Resume to continue.`, 'ln-err', ts);
    }
    return;
  }

  if (ev.kind === 'failover') {
    const fromM = String(ev.fromModel || '').replace(/^opencode\//, '');
    const toM = String(ev.toModel || '').replace(/^opencode\//, '');
    logLine(
      `⚡ Quota limit hit on ${ev.fromEngine}/${fromM} — auto-switched @${ev.agent} to ${ev.toEngine}/${toM} and continuing task (attempt ${ev.attempt}/${ev.maxRetries})…`,
      'ln-failover',
      ts
    );
    fetchTeam();
    loadPreferences();
    fetchMemory();
    return;
  }

  if (ev.kind === 'journal') {
    const e = ev.entry || {};
    logLine(`📋 shift log [${ev.agent}]: ${e.summary || e.status || 'done'}`, 'ln-done', ts);
    if (shiftsOn) fetchJournal();
    return;
  }

  if (ev.kind === 'status') {
    if (ev.stages) applyRailStages(ev.stages);
    if (ev.status === 'running') {
      if (pausePhaseBtn) pausePhaseBtn.hidden = !ev.isPhased;
      const eng = ev.engine ? ` [${ev.engine}]` : '';
      return logLine(`run started${eng}${ev.isPhased ? ' (phased memory pipeline)' : ''}${ev.dir ? ' in ' + ev.dir : ''}`, 'ln-sys', ts);
    }
    logEl.classList.remove('running');
    if (ev.status === 'done') {
      logLine('✓ run finished', 'ln-done', ts);
      railFinish(true, { stages: ev.stages });
    } else if (ev.status === 'paused') {
      logLine('⏸ phase complete — run paused with memory saved. Click ▶ Resume / Next Phase to continue.', 'ln-stage', ts);
      railFinish(true, { interrupted: true, stages: ev.stages });
    } else if (ev.status === 'stopped') {
      logLine('■ run stopped (progress saved in project memory)', 'ln-err', ts);
      railFinish(false, { interrupted: true, stages: ev.stages });
    } else {
      logLine(`✗ run ${ev.status} (${ev.error || ('exit ' + (ev.exitCode ?? '?'))})`, 'ln-err', ts);
      railFinish(false, { stages: ev.stages });
    }
    closeStream();
    setAssignState('idle');
    state.currentRunId = null;
    refreshProjectContext();
    fetchLedger();
    return;
  }
  if (ev.kind === 'json') return renderJsonEvent(ev);
  if (ev.kind === 'raw') return logLine(ev.text, ev.stream === 'stderr' ? 'ln-err' : 'ln-text', ts);
}

let replayEs = null;

async function fetchLedger() {
  try {
    const r = await fetch('/api/runs');
    const data = await r.json();
    const list = Array.isArray(data.runs) ? data.runs : [];
    renderLedger(list);
    return list;
  } catch {
    return [];
  }
}

function projectBasename(dir) {
  return String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '—';
}

function renderLedger(runs) {
  runLedger.innerHTML = '';
  if (!runs.length) {
    runLedger.appendChild(el('div', 'run-empty', 'No runs this session — assign a task and it lands here.'));
    return;
  }
  for (const run of runs) {
    const status = ['running', 'done', 'stopped', 'error'].includes(run.status) ? run.status : 'error';
    const row = el('div', 'run-row');
    const main = el('button', 'run-main');
    main.type = 'button';
    main.setAttribute('aria-label', status === 'running' ? `Attach to live run ${run.id}` : `Replay run ${run.id} (status ${status})`);
    const started = run.startedAt ? new Date(run.startedAt) : null;
    const timeText = started && !Number.isNaN(started.getTime()) ? started.toLocaleTimeString() : '—';
    let durationText = '—';
    if (started && !Number.isNaN(started.getTime())) {
      const end = run.endedAt ? new Date(run.endedAt) : new Date();
      if (!Number.isNaN(end.getTime())) durationText = fmtDuration(Math.max(0, end - started));
    }
    main.append(
      el('span', `run-chip ${status}`, status),
      el('span', 'run-time', timeText),
      el('span', 'run-agent', String(run.agent || '—')),
      el('span', 'run-project', projectBasename(run.dir)),
      el('span', 'run-duration', durationText),
      el('span', 'run-task', String(run.task || '').slice(0, 100))
    );
    main.addEventListener('click', () => {
      if (status === 'running') attachRun(run.id, run);
      else replayRun(run.id, run);
    });
    row.appendChild(main);
    if (status === 'running') {
      if (run.id === state.currentRunId) row.appendChild(el('span', 'run-live-hint', '● live'));
      const stopOne = el('button', 'btn btn-danger btn-small run-stop', 'Stop');
      stopOne.type = 'button';
      stopOne.setAttribute('aria-label', `Stop ${run.id}`);
      stopOne.addEventListener('click', async () => {
        try { await fetch(`/api/runs/${encodeURIComponent(run.id)}/stop`, { method: 'POST' }); } catch { /* ignore */ }
        logLine('stop requested — halting run process', 'ln-err');
        fetchLedger();
      });
      row.appendChild(stopOne);
    }
    runLedger.appendChild(row);
  }
}

function attachRun(id, runMeta = null) {
  if (state.currentRunId === id) {
    showWireView();
    return;
  }
  if (state.currentRunId) detachCurrentRun();
  showWireView();
  setAssignState('live');
  if (runMeta) {
    railReset(runMeta.agent || 'dispatcher', runMeta.startedAt);
    if (runMeta.stages) applyRailStages(runMeta.stages);
  }
  watchRun(id);
}

function replayRun(id, runMeta = null) {
  if (state.currentRunId) detachCurrentRun();
  showWireView();
  clearEmptyState();
  const stale = logEl.querySelectorAll(':scope > .ln');
  stale.forEach(n => n.remove());
  logLine(`replaying ${id}`, 'ln-sys');
  if (runMeta && runMeta.stages) applyRailStages(runMeta.stages);
  if (replayEs) { replayEs.close(); replayEs = null; }
  const es = new EventSource('/api/stream?run=' + encodeURIComponent(id));
  replayEs = es;
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { logLine(m.data, 'ln-sys'); return; }
    if (ev.kind === 'status' && ev.status !== 'running') {
      if (ev.stages) applyRailStages(ev.stages);
      if (ev.status === 'done') logLine('✓ run finished', 'ln-done', ev.ts);
      else if (ev.status === 'stopped') logLine('■ run stopped', 'ln-err', ev.ts);
      else logLine(`✗ run ${ev.status} (exit ${ev.exitCode ?? '?'})`, 'ln-err', ev.ts);
      es.close(); if (replayEs === es) replayEs = null;
      return;
    }
    handleEvent(ev);
  };
  es.onerror = () => { es.close(); if (replayEs === es) replayEs = null; };
}

function watchRun(id) {
  if (replayEs) { replayEs.close(); replayEs = null; }
  closeStream();
  state.currentRunId = id;
  logEl.classList.add('running');
  stopBtn.disabled = false;
  if (detachBtn) detachBtn.hidden = false;
  state.es = new EventSource('/api/stream?run=' + encodeURIComponent(id));
  state.es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch { logLine(m.data, 'ln-sys'); } };
  state.es.onerror = () => { logEl.classList.remove('running'); closeStream(); state.currentRunId = null; setAssignState('idle'); fetchLedger(); };
}

async function dispatchTask(task, dir) {
  if (state.currentRunId) return logLine('a run is already attached — click Detach or Stop run first', 'ln-err');
  clearEmptyState();
  logLine(`assigning to @${state.selectedAgent}: “${task}”`, 'ln-sys');
  setAssignState('sending');
  railReset(state.selectedAgent);
  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, agent: state.selectedAgent, dir }),
    });
    const data = await r.json();
    if (!r.ok) {
      logLine(`not assigned: ${data.error || 'unknown error'} — check the project path and try again`, 'ln-err');
      railFinish(false);
      setAssignState('idle');
      return;
    }
    if (data.stages) applyRailStages(data.stages);
    watchRun(data.id);
    setAssignState('live');
  } catch (e) {
    logLine(`not assigned: ${e.message} — check the project path and try again`, 'ln-err');
    railFinish(false);
    setAssignState('idle');
  }
}

/* ---------- quick task templates ---------- */
const TASK_TEMPLATES = {
  feature: {
    agent: 'dispatcher',
    prompt: 'Team, take this feature through the full pipeline (plan -> build -> test -> review -> report): ',
  },
  plan: {
    agent: 'architect',
    prompt: 'Produce an implementation plan (Goal, Acceptance criteria, Files to modify, Design notes, Risks, Test strategy) for: ',
  },
  qa: {
    agent: 'qa',
    prompt: 'Run the full test suite, diagnose any failures, add missing tests for recent changes, and report the verdict.',
  },
  review: {
    agent: 'reviewer',
    prompt: 'Perform a read-only code review of the current branch diff (correctness, security, data integrity, performance, maintainability) and output your verdict.',
  },
  explain: {
    agent: 'explainer',
    prompt: 'Read this project end-to-end and write docs/PROJECT-GUIDE.md covering purpose, stack, run commands, architecture, data flow, and gotchas.',
  },
};

document.querySelectorAll('.tpl-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const tpl = TASK_TEMPLATES[btn.dataset.tpl];
    if (!tpl) return;
    selectAgent(tpl.agent);
    const input = $('#taskInput');
    input.value = tpl.prompt;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
});

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
  logLine('stop requested — halting run process', 'ln-err');
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

function refreshProjectContext() {
  fetchTeam();
  fetchReports();
  fetchMetrics();
  fetchGitStatus();
  fetchMemory();
  if (shiftsOn) fetchJournal();
}

/* ---------- phased project memory & continuation ---------- */
const memoryBar = $('#memoryBar');
const memoryStatusBadge = $('#memoryStatusBadge');
const memoryTaskLabel = $('#memoryTaskLabel');
const memoryEngineLabel = $('#memoryEngineLabel');
const memoryPhasePills = $('#memoryPhasePills');
const resumePhaseBtn = $('#resumePhaseBtn');
const openMemoryBtn = $('#openMemoryBtn');
const resetMemoryBtn = $('#resetMemoryBtn');
const memoryOverlay = $('#memoryOverlay');

async function fetchMemory() {
  try {
    const dir = selectedDir();
    const r = await fetch('/api/memory' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    const data = await r.json();
    state.memory = data.memory || null;
    renderMemoryBar(state.memory);
  } catch { /* ignore */ }
}

function renderMemoryBar(mem) {
  if (!memoryBar) return;
  if (!mem || !mem.originalTask) {
    memoryBar.hidden = true;
    return;
  }
  memoryBar.hidden = false;
  const phases = Array.isArray(mem.phases) ? mem.phases : [];
  const curIdx = typeof mem.currentPhaseIndex === 'number' ? mem.currentPhaseIndex : 0;
  const curPhase = phases[curIdx] || phases[phases.length - 1] || null;
  const st = (mem.status || 'paused').toLowerCase();

  if (memoryStatusBadge) {
    if (st === 'running') {
      memoryStatusBadge.textContent = curPhase ? `RUNNING · PHASE ${curIdx + 1}/${phases.length} (${curPhase.label.toUpperCase()})` : 'RUNNING';
      memoryStatusBadge.className = 'memory-badge live';
    } else if (st === 'completed') {
      memoryStatusBadge.textContent = 'COMPLETED · MEMORY SAVED';
      memoryStatusBadge.className = 'memory-badge done';
    } else {
      memoryStatusBadge.textContent = curPhase ? `PAUSED · NEXT: ${curPhase.label.toUpperCase()} (${curIdx + 1}/${phases.length})` : 'PAUSED · RESUMABLE';
      memoryStatusBadge.className = 'memory-badge paused';
    }
  }

  if (memoryTaskLabel) {
    memoryTaskLabel.textContent = mem.originalTask;
  }
  if (memoryEngineLabel) {
    const shortM = String(mem.lastModel || '').replace(/^opencode\//, '');
    const failCount = Array.isArray(mem.failovers) && mem.failovers.length ? ` · ⚡ ${mem.failovers.length} failover${mem.failovers.length === 1 ? '' : 's'}` : '';
    memoryEngineLabel.textContent = mem.lastEngine ? `last: ${mem.lastEngine}${shortM ? ' / ' + shortM : ''}${failCount}` : '';
  }

  if (resumePhaseBtn) {
    resumePhaseBtn.disabled = Boolean(state.currentRunId);
    if (st === 'completed') {
      resumePhaseBtn.textContent = '▶ Re-run Pipeline';
    } else if (curPhase) {
      resumePhaseBtn.textContent = `▶ Continue: ${curPhase.label}`;
    } else {
      resumePhaseBtn.textContent = '▶ Resume Task';
    }
  }

  if (memoryPhasePills) {
    memoryPhasePills.innerHTML = '';
    phases.forEach((p, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const pStatus = p.status || 'pending';
      const isCurrent = idx === curIdx && st !== 'completed';
      btn.className = `phase-pill ${pStatus}${isCurrent ? ' current' : ''}`;
      const icon = pStatus === 'done' ? '✓' : pStatus === 'running' ? '●' : pStatus === 'failed' ? '✗' : `${idx + 1}`;
      const usedModel = p.model ? ` (${p.engine || ''}/${String(p.model).replace(/^opencode\//, '')})` : '';
      btn.textContent = `${icon} ${p.label} · @${p.agent}`;
      btn.title = `${p.label} (@${p.agent})${usedModel}${p.summary ? '\nSummary: ' + p.summary : ''}\nClick to resume from this phase`;
      btn.addEventListener('click', () => {
        if (state.currentRunId) return logLine('stop or wait for the current run before jumping to another phase', 'ln-err');
        continueFromMemory(idx);
      });
      memoryPhasePills.appendChild(btn);
    });
  }
}

async function continueFromMemory(phaseIndex = null) {
  if (state.currentRunId) return logLine('a run is already attached — click Detach or Stop run first', 'ln-err');
  const dir = selectedDir();
  clearEmptyState();
  logLine(`resuming project task from memory${typeof phaseIndex === 'number' ? ` (phase ${phaseIndex + 1})` : ''} using active engine [${state.engine}]…`, 'ln-stage');
  setAssignState('sending');
  try {
    const body = { dir };
    if (typeof phaseIndex === 'number') body.phaseIndex = phaseIndex;
    const r = await fetch('/api/run/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      logLine(`could not resume: ${data.error || 'unknown error'}`, 'ln-err');
      setAssignState('idle');
      return;
    }
    railReset('dispatcher');
    if (data.stages) applyRailStages(data.stages);
    watchRun(data.id);
    setAssignState('live');
    fetchMemory();
  } catch (e) {
    logLine(`could not resume: ${e.message}`, 'ln-err');
    setAssignState('idle');
  }
}

async function resetProjectMemory() {
  const dir = selectedDir();
  if (!confirm('Clear the saved project memory & phase checkpoints for this folder?')) return;
  try {
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, action: 'clear' }),
    });
    state.memory = null;
    renderMemoryBar(null);
    logLine('cleared project memory for current folder', 'ln-sys');
  } catch { /* ignore */ }
}

function openMemoryModal() {
  if (!memoryOverlay) return;
  const mem = state.memory;
  if (!mem) return;
  $('#memoryTaskEdit').value = mem.originalTask || '';
  $('#memoryNotesEdit').value = mem.notes || '';
  $('#memoryPlanEdit').value = mem.planSummary || '';
  const metaNote = $('#memoryMetaNote');
  if (metaNote) {
    metaNote.textContent = `Branch: ${mem.gitBranch || '—'} · Updated: ${mem.updatedAt ? new Date(mem.updatedAt).toLocaleString() : '—'}`;
  }
  const list = $('#memoryModalPhases');
  if (list) {
    list.innerHTML = '';
    const phases = Array.isArray(mem.phases) ? mem.phases : [];
    phases.forEach((p, idx) => {
      const row = el('div', 'mem-phase-row');
      const head = el('div', 'mem-phase-head');
      const badge = el('span', `phase-pill ${p.status || 'pending'}`, `${idx + 1}. ${p.label} (@${p.agent}) — ${p.status || 'pending'}`);
      const modelInfo = el('span', 'mem-phase-model', p.model ? `${p.engine || 'cli'} / ${String(p.model).replace(/^opencode\//, '')}` : 'not run yet');
      const runHere = el('button', 'btn btn-quiet btn-tiny', '▶ Resume here');
      runHere.type = 'button';
      runHere.disabled = Boolean(state.currentRunId);
      runHere.addEventListener('click', () => {
        memoryOverlay.hidden = true;
        continueFromMemory(idx);
      });
      head.append(badge, modelInfo, runHere);
      row.appendChild(head);
      if (p.summary) {
        row.appendChild(el('div', 'mem-phase-summary', p.summary));
      }
      list.appendChild(row);
    });
  }
  memoryOverlay.hidden = false;
  $('#closeMemoryModal').focus();
}

async function saveMemoryEdits() {
  const dir = selectedDir();
  const originalTask = $('#memoryTaskEdit').value.trim();
  const notes = $('#memoryNotesEdit').value;
  const planSummary = $('#memoryPlanEdit').value;
  try {
    const r = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, action: 'update', originalTask, notes, planSummary }),
    });
    const data = await r.json();
    if (r.ok && data.memory) {
      state.memory = data.memory;
      renderMemoryBar(state.memory);
      logLine('saved updated project memory & handoff notes to .ai-team/memory.json and docs/PROJECT-MEMORY.md', 'ln-done');
      memoryOverlay.hidden = true;
    }
  } catch { /* ignore */ }
}

if (resumePhaseBtn) resumePhaseBtn.addEventListener('click', () => continueFromMemory(null));
if (openMemoryBtn) openMemoryBtn.addEventListener('click', openMemoryModal);
if (resetMemoryBtn) resetMemoryBtn.addEventListener('click', resetProjectMemory);
if ($('#closeMemoryModal')) $('#closeMemoryModal').addEventListener('click', () => { memoryOverlay.hidden = true; });
if ($('#closeMemoryDoneBtn')) $('#closeMemoryDoneBtn').addEventListener('click', () => { memoryOverlay.hidden = true; });
if ($('#saveMemoryBtn')) $('#saveMemoryBtn').addEventListener('click', saveMemoryEdits);
if (memoryOverlay) {
  memoryOverlay.addEventListener('click', (e) => { if (e.target.hasAttribute('data-memory-close')) memoryOverlay.hidden = true; });
}

$('#refreshReports').addEventListener('click', fetchReports);
$('#projectSelect').addEventListener('change', (e) => {
  if (!e.target.value) return;
  $('#dirInput').value = e.target.value;
  localStorage.setItem('hq.dir', e.target.value);
  refreshProjectContext();
});
$('#dirInput').addEventListener('change', () => {
  localStorage.setItem('hq.dir', $('#dirInput').value.trim());
  refreshProjectContext();
});
$('#registerProjectBtn').addEventListener('click', registerCurrentFolder);
if ($('#unregisterProjectBtn')) {
  $('#unregisterProjectBtn').addEventListener('click', unregisterSelectedFolder);
}
$('#toggleNewProject').addEventListener('click', () => {
  const panel = $('#newProjectPanel');
  panel.hidden = !panel.hidden;
  $('#toggleNewProject').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) $('#newProjectName').focus();
});
$('#createProjectBtn').addEventListener('click', createProject);
$('#dirInput').value = localStorage.getItem('hq.dir') || '';

/* ---------- shift log ---------- */
const shiftViewBtn = $('#shiftViewBtn');
const shiftView = $('#shiftView');
let shiftsOn = false;

/* ---------- run ledger ---------- */
const runLedgerBtn = $('#runLedgerBtn');
const runLedger = $('#runLedger');
let ledgerOn = false;

function showWireView() {
  shiftsOn = false; ledgerOn = false;
  shiftViewBtn.setAttribute('aria-pressed', 'false');
  shiftViewBtn.textContent = 'shift log';
  runLedgerBtn.setAttribute('aria-pressed', 'false');
  $('#log').hidden = false;
  if ($('#wireToolbar')) $('#wireToolbar').hidden = false;
  shiftView.hidden = true;
  runLedger.hidden = true;
}

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
  const dir = selectedDir();
  const r = await fetch('/api/journal' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
  return r.json();
}
async function fetchJournal() {
  try { renderShiftView(await fetchJournalData()); } catch { /* leave panel as-is */ }
}

shiftViewBtn.addEventListener('click', () => {
  shiftsOn = !shiftsOn;
  if (shiftsOn) { ledgerOn = false; runLedgerBtn.setAttribute('aria-pressed', 'false'); runLedger.hidden = true; }
  shiftViewBtn.setAttribute('aria-pressed', String(shiftsOn));
  shiftViewBtn.textContent = shiftsOn ? 'live wire' : 'shift log';
  $('#log').hidden = shiftsOn;
  if ($('#wireToolbar')) $('#wireToolbar').hidden = shiftsOn;
  shiftView.hidden = !shiftsOn;
  if (shiftsOn) fetchJournal();
});

runLedgerBtn.addEventListener('click', () => {
  ledgerOn = !ledgerOn;
  if (ledgerOn) { shiftsOn = false; shiftViewBtn.setAttribute('aria-pressed', 'false'); shiftViewBtn.textContent = 'shift log'; shiftView.hidden = true; }
  runLedgerBtn.setAttribute('aria-pressed', String(ledgerOn));
  $('#log').hidden = ledgerOn;
  if ($('#wireToolbar')) $('#wireToolbar').hidden = ledgerOn;
  runLedger.hidden = !ledgerOn;
  if (ledgerOn) fetchLedger();
});

/* ---------- stage sheet (rail drill-down) ---------- */
const STAGE_DEFS = {
  intake: { owners: ['dispatcher'] },
  plan:   { owners: ['architect'] },
  build:  { owners: ['backend', 'frontend'] },
  test:   { owners: ['qa'] },
  review: { owners: ['reviewer'] },
  report: { owners: ['reporter', 'explainer'] },
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

  if (key === 'intake') {
    const sec = el('div', 'stage-section');
    sec.appendChild(el('h3', null, 'last run in this project'));
    const box = el('div', 'stage-run');
    try {
      const dir = selectedDir();
      const m = await fetch('/api/metrics' + (dir ? '?dir=' + encodeURIComponent(dir) : '')).then(r => r.json());
      if (m && m.last) {
        box.append('dispatched to ', el('b', null, m.last.agent), ' · ');
        const s = el('span', m.last.status === 'done' ? 'run-ok' : 'run-bad', m.last.status);
        box.append(s, el('br'), document.createTextNode(m.last.task || '—'));
      } else {
        box.textContent = 'No runs on record for this project — assign the crew a task first.';
      }
    } catch { box.textContent = 'Metrics unavailable.'; }
    sec.appendChild(box);
    stageBody.appendChild(sec);
  }

  const secJ = el('div', 'stage-section');
  secJ.appendChild(el('h3', null, 'from the shift log'));
  let data = null;
  try { data = await fetchJournalData(); } catch { /* fall through */ }
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

/* ---------- crew setup (per-employee model & engine settings) ---------- */
const settingsOverlay = $('#settingsOverlay');
const settingsBody = $('#settingsBody');
let settingsPrevFocus = null;

function openSettings() {
  settingsPrevFocus = document.activeElement;
  settingsOverlay.hidden = false;
  $('#closeSettings').focus();
  loadPreferences();
  loadSettings();
}
function closeSettings() {
  settingsOverlay.hidden = true;
  if (settingsPrevFocus && settingsPrevFocus.focus) settingsPrevFocus.focus();
}
$('#openSettings').addEventListener('click', openSettings);
if (engineBadge) engineBadge.addEventListener('click', openSettings);
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
    ['engine', v.engine],
    ['runs', v.sessions],
    ['employees', v.subagents],
    ['green runs', v.prompts],
    ['speed', v.steps],
    ['plan', v.tokens],
    ['success rate', v.toolSuccess],
  ].filter(([, n]) => n);
  elx.innerHTML = chips.map(([k, n]) => `<span class="vital-chip"><b>${n}</b> ${k}</span>`).join('');
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
        if (r.ok) { flash('saved ✓', true); fetchTeam(); } else flash(out.error || 'failed', false);
      } catch (e) { flash(String(e.message || e), false); }
    };

    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Model for ${a.id}`);
    const current = a.effectiveModel || '';
    for (const m of data.catalog) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m.replace(/^opencode\//, '') + (free.has(m) ? ' · included' : '');
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
  distributeNote.textContent = 'assigning recommended models…';
  try {
    const r = await fetch('/api/agents/distribute', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) { distributeNote.textContent = `not assigned: ${data.error || 'unknown error'}`; return; }
    const lines = Object.entries(data.assignment).map(([id, m]) => `${id} → ${m.replace(/^opencode\//, '')}`);
    distributeNote.textContent = `Assigned models across the bench: ${lines.join(' · ')}`;
    loadSettings();
    fetchTeam();
  } catch (e) {
    distributeNote.textContent = `not assigned: ${String(e.message || e)}`;
  } finally {
    distributeFreeBtn.disabled = false;
  }
}
distributeFreeBtn.addEventListener('click', distributeFree);

/* ---------- preferences (engine, routing, watchdog, phased memory & quota failover) ---------- */
const routingStaticBtn = $('#routingStatic');
const routingDynamicBtn = $('#routingDynamic');
const engineAgyBtn = $('#engineAgy');
const engineOpencodeBtn = $('#engineOpencode');
const timeoutInput = $('#timeoutInput');
const modePhasedBtn = $('#modePhased');
const modeSingleBtn = $('#modeSingle');
const advanceAutoBtn = $('#advanceAuto');
const advanceManualBtn = $('#advanceManual');
const memoryOnBtn = $('#memoryOn');
const memoryOffBtn = $('#memoryOff');
const quotaSwitchOnBtn = $('#quotaSwitchOn');
const quotaSwitchOffBtn = $('#quotaSwitchOff');
const crossEngineOnBtn = $('#crossEngineOn');
const crossEngineOffBtn = $('#crossEngineOff');
const maxRetriesInput = $('#maxRetriesInput');
const clearCooldownsBtn = $('#clearCooldownsBtn');

function setPrefsUI(p) {
  if (!p) return;
  routingStaticBtn.setAttribute('aria-pressed', String(p.modelRouting === 'static'));
  routingDynamicBtn.setAttribute('aria-pressed', String(p.modelRouting === 'dynamic'));
  if (engineAgyBtn && engineOpencodeBtn) {
    engineAgyBtn.setAttribute('aria-pressed', String(p.engine !== 'opencode'));
    engineOpencodeBtn.setAttribute('aria-pressed', String(p.engine === 'opencode'));
  }
  if (timeoutInput && p.inactivityTimeoutMin) {
    timeoutInput.value = String(p.inactivityTimeoutMin);
  }
  if (modePhasedBtn && modeSingleBtn) {
    modePhasedBtn.setAttribute('aria-pressed', String(p.executionMode !== 'single'));
    modeSingleBtn.setAttribute('aria-pressed', String(p.executionMode === 'single'));
  }
  if (advanceAutoBtn && advanceManualBtn) {
    advanceAutoBtn.setAttribute('aria-pressed', String(p.phaseAdvance !== 'manual'));
    advanceManualBtn.setAttribute('aria-pressed', String(p.phaseAdvance === 'manual'));
  }
  if (memoryOnBtn && memoryOffBtn) {
    memoryOnBtn.setAttribute('aria-pressed', String(p.projectMemory !== false));
    memoryOffBtn.setAttribute('aria-pressed', String(p.projectMemory === false));
  }
  if (quotaSwitchOnBtn && quotaSwitchOffBtn) {
    quotaSwitchOnBtn.setAttribute('aria-pressed', String(p.quotaAutoSwitch !== false));
    quotaSwitchOffBtn.setAttribute('aria-pressed', String(p.quotaAutoSwitch === false));
  }
  if (crossEngineOnBtn && crossEngineOffBtn) {
    crossEngineOnBtn.setAttribute('aria-pressed', String(p.crossEngineFallback !== false));
    crossEngineOffBtn.setAttribute('aria-pressed', String(p.crossEngineFallback === false));
  }
  if (maxRetriesInput && p.maxQuotaRetries) {
    maxRetriesInput.value = String(p.maxQuotaRetries);
  }
  if (clearCooldownsBtn) {
    const cd = Array.isArray(p.cooldowns) ? p.cooldowns : [];
    clearCooldownsBtn.hidden = cd.length === 0;
    clearCooldownsBtn.textContent = `Clear cooldowns (${cd.length})`;
    clearCooldownsBtn.title = cd.map(c => `${c.engine}/${c.model} (${c.remainingSec}s)`).join(', ');
  }
}

async function loadPreferences() {
  try {
    const r = await fetch('/api/preferences');
    const p = await r.json();
    setPrefsUI(p);
  } catch { /* leave as-is */ }
}

async function updatePreference(patch) {
  try {
    const r = await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const p = await r.json();
    if (r.ok) {
      setPrefsUI(p);
      fetchTeam();
      if (!settingsOverlay.hidden && patch.engine) loadSettings();
    }
  } catch { /* leave as-is */ }
}

routingStaticBtn.addEventListener('click', () => updatePreference({ modelRouting: 'static' }));
routingDynamicBtn.addEventListener('click', () => updatePreference({ modelRouting: 'dynamic' }));
if (engineAgyBtn) engineAgyBtn.addEventListener('click', () => updatePreference({ engine: 'agy' }));
if (engineOpencodeBtn) engineOpencodeBtn.addEventListener('click', () => updatePreference({ engine: 'opencode' }));
if (timeoutInput) {
  timeoutInput.addEventListener('change', () => {
    const val = Number(timeoutInput.value);
    if (Number.isFinite(val) && val >= 1 && val <= 120) {
      updatePreference({ inactivityTimeoutMin: val });
    }
  });
}
if (modePhasedBtn) modePhasedBtn.addEventListener('click', () => updatePreference({ executionMode: 'phased' }));
if (modeSingleBtn) modeSingleBtn.addEventListener('click', () => updatePreference({ executionMode: 'single' }));
if (advanceAutoBtn) advanceAutoBtn.addEventListener('click', () => updatePreference({ phaseAdvance: 'auto' }));
if (advanceManualBtn) advanceManualBtn.addEventListener('click', () => updatePreference({ phaseAdvance: 'manual' }));
if (memoryOnBtn) memoryOnBtn.addEventListener('click', () => updatePreference({ projectMemory: true }));
if (memoryOffBtn) memoryOffBtn.addEventListener('click', () => updatePreference({ projectMemory: false }));
if (quotaSwitchOnBtn) quotaSwitchOnBtn.addEventListener('click', () => updatePreference({ quotaAutoSwitch: true }));
if (quotaSwitchOffBtn) quotaSwitchOffBtn.addEventListener('click', () => updatePreference({ quotaAutoSwitch: false }));
if (crossEngineOnBtn) crossEngineOnBtn.addEventListener('click', () => updatePreference({ crossEngineFallback: true }));
if (crossEngineOffBtn) crossEngineOffBtn.addEventListener('click', () => updatePreference({ crossEngineFallback: false }));
if (maxRetriesInput) {
  maxRetriesInput.addEventListener('change', () => {
    const val = Number(maxRetriesInput.value);
    if (Number.isFinite(val) && val >= 1 && val <= 10) {
      updatePreference({ maxQuotaRetries: val });
    }
  });
}
if (clearCooldownsBtn) {
  clearCooldownsBtn.addEventListener('click', () => updatePreference({ clearCooldowns: true }));
}

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
  if (e.key === 'Escape') {
    if (memoryOverlay && !memoryOverlay.hidden) { memoryOverlay.hidden = true; return; }
    if (!settingsOverlay.hidden) { closeSettings(); return; }
    if (!stageSheet.hidden) { closeStageSheet(); return; }
    if (!guideOverlay.hidden) { closeGuide(); return; }
    return;
  }
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

/* ---------- initial bootstrap & auto-attach to live run ---------- */
async function initDashboard() {
  loadProjects();
  loadPreferences();
  refreshProjectContext();
  const runsList = await fetchLedger();
  const activeRun = runsList.find(r => r.status === 'running');
  if (activeRun && !state.currentRunId) {
    attachRun(activeRun.id, activeRun);
  }
}

initDashboard();
setInterval(fetchTeam, 5000);
setInterval(fetchReports, 10000);
setInterval(fetchMetrics, 15000);
setInterval(fetchGitStatus, 12000);
setInterval(() => { if (shiftsOn) fetchJournal(); }, 10000);
setInterval(() => { if (ledgerOn) fetchLedger(); }, 8000);
