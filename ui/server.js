/**
 * AI Team HQ — zero-dependency local dashboard for the AI Team.
 * Serves on http://127.0.0.1:4357  (override with PORT env var)
 *
 * Endpoints:
 *   GET  /                  → the dashboard
 *   GET  /api/team          → roster parsed from .opencode/agents/*.md (+ live status)
 *   GET  /api/reports       → list reports/*.md
 *   GET  /api/reports/<f>   → raw markdown of one report
 *   POST /api/run           → { task, agent?, dir? } → launches `opencode run`
 *   GET  /api/stream?run=id → SSE: live events of a run (replays buffered events)
 *   GET  /api/runs          → in-memory history of this session's runs
 *   POST /api/runs/<id>/stop→ kill a running job
 *
 * Privacy/safety notes:
 *   - Binds to 127.0.0.1 only. Anyone with your machine can use it.
 *   - Runs use `opencode run --auto` so agents don't stall waiting for approvals.
 *   - Free opencode models may train on inputs — don't send secrets.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');           // the "AI team" folder
const PUBLIC = path.join(__dirname, 'public');
const REPORTS = path.join(ROOT, 'reports');
const AGENTS_DIR = path.join(ROOT, '.opencode', 'agents');
const PROJECTS_FILE = path.join(ROOT, 'projects.json');
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'project');
const METRICS_FILE = path.join(ROOT, 'reports', '.metrics.jsonl');
const PORT = Number(process.env.PORT || 4357);
const HOST = '127.0.0.1';
const MAX_EVENTS_PER_RUN = 400;
const MAX_RUNS_KEPT = 50;

// Resolve the real opencode binary (works around the .ps1/.cmd shim on Windows)
const EXE_CANDIDATE = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  : 'opencode';
const OPENCODE = fs.existsSync(EXE_CANDIDATE) ? EXE_CANDIDATE : 'opencode';

const ROSTER = [
  { id: 'dispatcher', code: 'PM', no: '001', color: '#E8590C', blurb: 'Routes a raw task through the pipeline: plan, build, test, review, file the report.' },
  { id: 'architect',  code: 'AR', no: '002', color: '#33608C', blurb: 'Turns a task into a plan: files to touch, risks, test strategy.' },
  { id: 'backend',    code: 'BE', no: '003', color: '#276A4B', blurb: 'APIs, data layer and business logic.' },
  { id: 'frontend',   code: 'FE', no: '004', color: '#6C4A8C', blurb: 'UI, styling, client behavior, accessibility.' },
  { id: 'qa',         code: 'QA', no: '005', color: '#0F6B78', blurb: 'Runs the suite, writes tests, hunts bugs.' },
  { id: 'reviewer',   code: 'RV', no: '006', color: '#B3402A', blurb: 'Read-only review of the diff: bugs, security, performance.' },
  { id: 'reporter',   code: 'RP', no: '007', color: '#4A4E42', blurb: 'Files the final report into reports/.' },
  { id: 'explainer',  code: 'EX', no: '008', color: '#8A6D2F', blurb: 'Reads the project end to end and files docs/PROJECT-GUIDE.md.' },
];

// ---------- in-memory run state ----------
const runs = new Map(); // id → run object
let runCounter = 0;

function pushEvent(run, event) {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.clients) {
    try { res.write(msg); } catch { /* client gone */ }
  }
}

function sseSend(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function startRun({ task, agent, dir }) {
  const id = `run-${Date.now()}-${++runCounter}`;
  const cwd = dir && dir.trim() ? path.resolve(dir.trim()) : ROOT;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  const run = {
    id, task, agent: agent || 'dispatcher', dir: cwd,
    startedAt: new Date().toISOString(), endedAt: null,
    status: 'running', exitCode: null, error: null,
    events: [], clients: new Set(), child: null,
  };
  const args = ['run', '--standalone', '--format', 'json', '--auto', '--agent', run.agent, '--title', `hq:${id}`, task];
  const child = execFile(OPENCODE, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }, (err) => {
    run.endedAt = new Date().toISOString();
    run.exitCode = err && typeof err.code === 'number' ? err.code : 0;
    run.status = err ? 'error' : 'done';
    pushEvent(run, { kind: 'status', status: run.status, exitCode: run.exitCode, endedAt: run.endedAt });
    appendMetric({
      id: run.id, agent: run.agent, dir: run.dir,
      task: String(run.task || '').slice(0, 500),
      startedAt: run.startedAt, endedAt: run.endedAt,
      durationMs: Math.max(0, new Date(run.endedAt) - new Date(run.startedAt)),
      status: run.status, exitCode: run.exitCode,
      eventCount: run.events.length,
    });
    for (const res of run.clients) { try { res.end(); } catch {} }
    run.clients.clear();
  });
  run.child = child;
  // Critical: the CLI blocks forever on a stdin pipe that never sees EOF.
  // Close it immediately — prompt comes from the argument, not stdin.
  if (child.stdin) child.stdin.end();

  const pump = (chunk, stream) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        const parsed = JSON.parse(trimmed);
        ev = { kind: 'json', stream, event: parsed };
      } catch {
        ev = { kind: 'raw', stream, text: trimmed };
      }
      pushEvent(run, ev);
    }
  };
  child.stdout.on('data', (d) => pump(d, 'stdout'));
  child.stderr.on('data', (d) => pump(d, 'stderr'));

  runs.set(id, run);
  try { // touch lastUsed in the registry (best effort)
    const key = normalizePathKey(cwd);
    const list = readRegistry();
    const i = list.findIndex(p => normalizePathKey(p && p.path) === key);
    if (i >= 0) { list[i].lastUsed = new Date().toISOString(); writeRegistry(list); }
  } catch { /* not a registered project */ }
  // keep map bounded
  if (runs.size > MAX_RUNS_KEPT) {
    const oldest = [...runs.keys()][0];
    runs.delete(oldest);
  }
  return run;
}

// ---------- agent frontmatter parsing (tiny, zero-dep) ----------
function parseAgentFileAt(dir, file) {
  const name = path.basename(file, '.md');
  let content = '';
  try { content = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const grab = (key) => {
    const r = new RegExp(`^${key}:\\s*(.+)$`, 'im').exec(fm);
    return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  return { id: name, description: grab('description'), mode: grab('mode'), model: grab('model') };
}
function parseAgentFile(file) { return parseAgentFileAt(AGENTS_DIR, file); }

// ---------- per-employee model settings ----------
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.config', 'opencode', 'agents');
let modelCatalogCache = { at: 0, list: [] };

// machine-wide console vitals, parsed from `opencode stats` (best effort)
function consoleVitals() {
  try {
    const out = execFileSync(OPENCODE, ['stats'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      .replace(/\x1b\[[0-9;]*m/g, '');
    const grab = re => { const m = out.match(re); return m ? m[1].trim() : null; };
    return {
      sessions: grab(/(\d+[\d,.]*)\s*sessions/i),
      subagents: grab(/(\d+[\d,.]*)\s*subagents/i),
      prompts: grab(/(\d+[\d,.]*)\s*prompts/i),
      steps: grab(/([\d.km]+)\s*steps/i),
      tokens: grab(/([\d.km]+)\s*tokens/i),
      toolSuccess: grab(/([\d.]+%)\s*tool success/i),
    };
  } catch { return null; }
}

function getModelCatalog() {
  const FRESH = 10 * 60 * 1000; // 10 minutes
  if (Date.now() - modelCatalogCache.at < FRESH && modelCatalogCache.list.length) return modelCatalogCache.list;
  try {
    const out = execFileSync(OPENCODE, ['models'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const list = [...new Set(
      out.split('\n').map(s => s.trim()).filter(l => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(l))
    )];
    if (list.length) modelCatalogCache = { at: Date.now(), list };
    return list;
  } catch {
    return modelCatalogCache.list; // stale is better than nothing
  }
}

function agentUsage() {
  const per = {};
  for (const r of readMetrics()) {
    const a = per[r.agent] = per[r.agent] || { total: 0, done: 0, totalMs: 0 };
    a.total += 1;
    if (r.status === 'done') a.done += 1;
    a.totalMs += r.durationMs || 0;
  }
  return per;
}

function agentSettingsPayload() {
  const catalog = getModelCatalog();
  const free = id => /-free$/.test(id);
  const usage = agentUsage();
  return {
    catalog,
    consoleVitals: consoleVitals(),
    agents: ROSTER.map(slot => {
      const local = parseAgentFileAt(AGENTS_DIR, slot.id + '.md');
      const globalOne = parseAgentFileAt(GLOBAL_AGENTS_DIR, slot.id + '.md');
      let effort = 'default';
      try {
        const raw = fs.readFileSync(path.join(AGENTS_DIR, slot.id + '.md'), 'utf8');
        const m = raw.match(/^reasoningEffort:\s*(\w+)$/mi);
        if (m) effort = m[1].toLowerCase();
      } catch { /* no file */ }
      return {
        id: slot.id, code: slot.code, no: slot.no, color: slot.color,
        blurb: slot.blurb,
        localModel: local && local.model || null,
        globalModel: globalOne && globalOne.model || null,
        effectiveModel: (local && local.model) || (globalOne && globalOne.model) || null,
        usage: usage[slot.id] || { total: 0, done: 0, totalMs: 0 },
        effort,
      };
    }),
    freeOnly: catalog.filter(free),
  };
}

const EFFORT_LEVELS = ['low', 'medium', 'high'];
function setAgentEffort(id, effort) {
  if (!ROSTER.some(s => s.id === id)) throw new Error(`unknown employee: ${id}`);
  const level = String(effort || '').toLowerCase();
  if (level && !EFFORT_LEVELS.includes(level)) throw new Error(`effort must be one of: ${EFFORT_LEVELS.join(', ')}, or empty for model default`);
  const updated = [];
  for (const dir of [GLOBAL_AGENTS_DIR, AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf8');
    // drop any existing reasoningEffort line, then re-add if a level is set
    content = content.replace(/^reasoningEffort:[^\n]*\n?/mi, '');
    if (level) {
      content = /^model:.*$/m.test(content)
        ? content.replace(/^model:.*$/m, m => `${m}\nreasoningEffort: ${level}`)
        : content.replace(/\n---/, `\nreasoningEffort: ${level}\n---`);
    }
    fs.writeFileSync(file, content);
    updated.push(dir);
  }
  return updated;
}

function setAgentModel(id, model) {
  if (!ROSTER.some(s => s.id === id)) throw new Error(`unknown employee: ${id}`);
  const catalog = getModelCatalog();
  if (catalog.length && !catalog.includes(model)) throw new Error(`model not in catalog: ${model} — run \`opencode models\` to see current free ones`);
  const updated = [];
  for (const dir of [GLOBAL_AGENTS_DIR, AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    if (!/^model:.*$/m.test(before)) { fs.writeFileSync(file, before.replace('\n---', `\nmodel: ${model}\n---`)); updated.push(dir + ' (model line added)'); continue; }
    const after = before.replace(/^model:.*$/m, `model: ${model}`);
    if (after !== before) { fs.writeFileSync(file, after); updated.push(dir); }
  }
  if (!updated.length) throw new Error(`no agent file found for ${id}`);
  return updated;
}

function agentEffortOf(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^reasoningEffort:\s*(\w+)$/mi);
    return m ? m[1].toLowerCase() : 'default';
  } catch { return 'default'; }
}

function teamPayload() {
  const files = fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')) : [];
  const meta = {};
  for (const f of files) { const p = parseAgentFile(f); if (p) meta[p.id] = p; }
  const activeIds = [...runs.values()].filter(r => r.status === 'running').map(r => r.agent);
  const usage = agentUsage();
  return ROSTER.map(slot => ({
    ...slot,
    mode: meta[slot.id]?.mode || 'subagent',
    model: meta[slot.id]?.model || 'inherited',
    description: meta[slot.id]?.description || '',
    effort: agentEffortOf(path.join(AGENTS_DIR, slot.id + '.md')),
    usage: usage[slot.id] || { total: 0, done: 0, totalMs: 0 },
    busy: activeIds.includes(slot.id),
  }));
}

// ---------- project registry (any absolute path, de-duplicated) ----------
function readRegistry() {
  try { const j = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function writeRegistry(list) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2)); }
function normalizePathKey(p) { return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function upsertRegistry(entry) {
  const key = normalizePathKey(entry.path);
  const rest = readRegistry().filter(p => normalizePathKey(p && p.path) !== key);
  rest.push(entry);
  writeRegistry(rest);
  return rest;
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function scaffoldProject({ name, targetPath }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) {
    throw new Error('Name must start with a letter or number; use only letters, digits, dot, dash, underscore (max 64).');
  }
  const dest = path.resolve(String(targetPath || ''));
  if (!path.isAbsolute(dest)) throw new Error('Path must be an absolute path, e.g. C:\\work\\my-app');
  const adopted = fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
  fs.mkdirSync(path.join(dest, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'journal'), { recursive: true });
  const copyIfMissing = (src, dst) => { if (!fs.existsSync(dst)) fs.copyFileSync(src, dst); };
  copyIfMissing(path.join(TEMPLATE_DIR, '.gitignore'), path.join(dest, '.gitignore'));
  copyIfMissing(path.join(TEMPLATE_DIR, 'docs', 'report-template.md'), path.join(dest, 'docs', 'report-template.md'));
  const agentsDst = path.join(dest, 'AGENTS.md');
  if (!fs.existsSync(agentsDst)) {
    fs.writeFileSync(agentsDst, fs.readFileSync(path.join(TEMPLATE_DIR, 'AGENTS.md'), 'utf8').replaceAll('{{NAME}}', name));
  }
  const gitkeep = path.join(dest, 'reports', '.gitkeep');
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, '');
  let git = 'already a repo';
  if (!fs.existsSync(path.join(dest, '.git'))) {
    try { execFileSync('git', ['-C', dest, 'init', '-b', 'main'], { stdio: 'ignore' }); git = 'initialized (branch main)'; }
    catch { try { execFileSync('git', ['-C', dest, 'init'], { stdio: 'ignore' }); git = 'initialized'; } catch { git = 'git unavailable — folder created without repo'; } }
  }
  const now = new Date().toISOString();
  upsertRegistry({ name, path: dest, addedAt: now, lastUsed: now });
  return { adopted, git, path: dest };
}

// ---------- run metrics (JSONL, honest history — never breaks a run) ----------
function appendMetric(entry) {
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n');
  } catch { /* metrics are best-effort */ }
}
function readMetrics() {
  try {
    return fs.readFileSync(METRICS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function metricsSummary() {
  const rows = readMetrics();
  const total = rows.length;
  const done = rows.filter(r => r.status === 'done').length;
  const durations = rows.map(r => r.durationMs).filter(n => typeof n === 'number' && n >= 0);
  const perAgent = {};
  for (const r of rows) {
    const a = perAgent[r.agent] = perAgent[r.agent] || { total: 0, done: 0 };
    a.total += 1;
    if (r.status === 'done') a.done += 1;
  }
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    total,
    done,
    errors: total - done,
    successRate: total ? Math.round((done / total) * 100) : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    perAgent,
    last: last ? {
      agent: last.agent, status: last.status, endedAt: last.endedAt,
      task: String(last.task || '').slice(0, 140),
    } : null,
  };
}

// ---------- reports ----------
function listReports() {
  if (!fs.existsSync(REPORTS)) return [];
  return fs.readdirSync(REPORTS)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const st = fs.statSync(path.join(REPORTS, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function readReport(name) {
  const resolved = path.resolve(REPORTS, name);
  if (!resolved.startsWith(REPORTS + path.sep) || !resolved.endsWith('.md') || !fs.existsSync(resolved)) {
    return null;
  }
  return fs.readFileSync(resolved, 'utf8');
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- API ----
    if (pathname === '/api/team' && req.method === 'GET') return sendJson(res, 200, { roster: teamPayload(), opencode: OPENCODE });
    if (pathname === '/api/reports' && req.method === 'GET') return sendJson(res, 200, { reports: listReports() });
    if (pathname.startsWith('/api/reports/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/reports/'.length));
      const md = readReport(name);
      return md === null ? sendJson(res, 404, { error: 'not found' }) : sendJson(res, 200, { name, content: md });
    }
    // ---- shift log (per-employee journals in the project being worked on) ----
    if (pathname === '/api/journal' && req.method === 'GET') {
      let target = ROOT;
      const q = url.searchParams.get('dir');
      if (q) {
        const resolved = path.resolve(q);
        if (path.isAbsolute(resolved) && isDir(resolved)) target = resolved;
      }
      const journalDir = path.join(target, 'journal');
      const agents = ROSTER.map(slot => {
        let entries = [];
        try {
          entries = fs.readFileSync(path.join(journalDir, slot.id + '.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean)
            .slice(-8)
            .map(e => ({
              ts: e.ts || null,
              task: String(e.task || '').slice(0, 160),
              summary: String(e.summary || '').slice(0, 400),
              status: ['done', 'partial', 'failed'].includes(e.status) ? e.status : 'unknown',
            }));
        } catch { /* this employee has no journal yet */ }
        return { ...slot, entries };
      });
      return sendJson(res, 200, { dir: target, agents });
    }

    // ---- crew settings (per-employee model assignment) ----
    if (pathname === '/api/agents/settings' && req.method === 'GET') return sendJson(res, 200, agentSettingsPayload());
    if (pathname === '/api/agents/settings' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      try {
        const id = String(body.id || '');
        const model = String(body.model || '');
        const effort = body.effort;
        let updated = [];
        if (model) updated = updated.concat(setAgentModel(id, model));
        if (effort !== undefined) updated = updated.concat(setAgentEffort(id, effort));
        if (!model && effort === undefined) throw new Error('nothing to change — pass model and/or effort');
        return sendJson(res, 200, { ok: true, id, updated });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/metrics' && req.method === 'GET') return sendJson(res, 200, metricsSummary());
    if (pathname === '/api/runs' && req.method === 'GET') {
      return sendJson(res, 200, { runs: [...runs.values()].map(({ child, clients, events, ...r }) => ({ ...r, eventCount: events.length })) });
    }
    if (pathname === '/api/run' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const task = (body.task || '').trim();
      if (!task) return sendJson(res, 400, { error: 'task is required' });
      const agent = /^[a-z][a-z-]*$/.test(body.agent || '') ? body.agent : 'dispatcher';
      try {
        const run = startRun({ task, agent, dir: body.dir });
        pushEvent(run, { kind: 'status', status: 'running', agent, dir: run.dir });
        return sendJson(res, 200, { id: run.id });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname.startsWith('/api/runs/') && pathname.endsWith('/stop') && req.method === 'POST') {
      const id = pathname.slice('/api/runs/'.length, -'/stop'.length);
      const run = runs.get(id);
      if (!run) return sendJson(res, 404, { error: 'unknown run' });
      if (run.child) run.child.kill();
      return sendJson(res, 200, { ok: true });
    }
    // ---- multi-project registry & scaffolding ----
    if (pathname === '/api/projects' && req.method === 'GET') {
      const projects = readRegistry()
        .map(p => ({ ...p, exists: isDir(p.path) }))
        .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
      return sendJson(res, 200, { projects });
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const target = path.resolve(String(body.path || ''));
      if (!isDir(target)) return sendJson(res, 400, { error: `Not a directory: ${target}` });
      const now = new Date().toISOString();
      const name = (body.name && String(body.name).trim()) || path.basename(target);
      upsertRegistry({ name, path: target, addedAt: now, lastUsed: now });
      return sendJson(res, 200, { ok: true, path: target });
    }
    if (pathname === '/api/projects/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      try {
        const result = scaffoldProject({ name: String(body.name || '').trim(), targetPath: String(body.path || '').trim() });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/projects' && req.method === 'DELETE') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = normalizePathKey(String(body.path || ''));
      const rest = readRegistry().filter(p => normalizePathKey(p && p.path) !== key);
      writeRegistry(rest);
      return sendJson(res, 200, { projects: rest });
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      const id = url.searchParams.get('run');
      const run = runs.get(id);
      if (!run) { res.writeHead(404); return res.end('unknown run'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      for (const ev of run.events) sseSend(res, ev);      // replay
      if (run.status === 'running') {
        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
      } else {
        res.end();
      }
      return;
    }

    // ---- static ----
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
      res.writeHead(403); return res.end('forbidden');
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Team HQ → http://${HOST}:${PORT}`);
  console.log(`Team root:  ${ROOT}`);
  console.log(`OpenCode:   ${OPENCODE}`);
});
