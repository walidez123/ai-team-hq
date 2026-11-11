/**
 * AI Team HQ — zero-dependency local dashboard for the AI Team.
 * Serves on http://127.0.0.1:4357  (override with PORT env var)
 *
 * Primary Engine: Google Antigravity CLI (`agy`)
 * Fallback Engine: OpenCode CLI (`opencode`)
 *
 * Endpoints:
 *   GET  /                     → the dashboard
 *   GET  /api/team             → roster parsed from .agents/agents/*.md (+ live status)
 *   GET  /api/reports          → list reports/*.md (supports ?dir=)
 *   GET  /api/reports/<f>      → raw markdown of one report (supports ?dir=)
 *   GET  /api/journal          → per-employee shift log entries (supports ?dir=)
 *   GET  /api/metrics          → run metrics summary (supports ?dir= for project scope)
 *   GET  /api/git-status       → current branch, dirty files, recent commits (supports ?dir=)
 *   GET  /api/agents/settings  → model catalog + per-employee model & effort
 *   POST /api/agents/settings  → update employee model and/or effort
 *   POST /api/agents/distribute→ spread optimal models across the 8 employees
 *   GET  /api/preferences      → engine, modelRouting, inactivityTimeoutMin
 *   POST /api/preferences      → update preferences
 *   GET  /api/projects         → list registered project folders
 *   POST /api/projects         → register an existing folder
 *   POST /api/projects/new     → scaffold or adopt a project folder
 *   DELETE /api/projects       → unregister a project folder
 *   POST /api/run              → { task, agent?, dir? } → launches CLI run
 *   GET  /api/stream?run=id    → SSE: live events of a run (replays buffered events)
 *   GET  /api/runs             → in-memory history of this session's runs
 *   POST /api/runs/<id>/stop   → kill a running job
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const ROOT = path.resolve(__dirname, '..');           // the "AI team" folder
const PUBLIC = path.join(__dirname, 'public');
const REPORTS = path.join(ROOT, 'reports');

// Antigravity agent directories (workspace + global plugin)
const AGY_AGENTS_DIR = path.join(ROOT, '.agents', 'agents');
const GLOBAL_AGY_PLUGIN_AGENTS_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'ai-team', 'agents');

// Legacy OpenCode agent directories (kept in sync for dual-engine compatibility)
const OPENCODE_AGENTS_DIR = path.join(ROOT, '.opencode', 'agents');
const GLOBAL_OPENCODE_AGENTS_DIR = path.join(os.homedir(), '.config', 'opencode', 'agents');

const PROJECTS_FILE = path.join(ROOT, 'projects.json');
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'project');
const METRICS_FILE = path.join(ROOT, 'reports', '.metrics.jsonl');
const PORT = Number(process.env.PORT || 4357);
const HOST = '127.0.0.1';
const MAX_EVENTS_PER_RUN = 600;
const MAX_RUNS_KEPT = 50;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Resolve Antigravity CLI (`agy`) binary
const AGY_CANDIDATE = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
  : 'agy';
const AGY_BIN = fs.existsSync(AGY_CANDIDATE) ? AGY_CANDIDATE : 'agy';

// Resolve OpenCode CLI (`opencode`) binary
const OPENCODE_CANDIDATE = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  : 'opencode';
const OPENCODE_BIN = fs.existsSync(OPENCODE_CANDIDATE) ? OPENCODE_CANDIDATE : 'opencode';

const ROSTER = [
  { id: 'dispatcher', code: 'PM', no: '001', color: '#E8590C', stage: 'intake', blurb: 'Routes a raw task through the pipeline: plan, build, test, review, file the report.' },
  { id: 'architect',  code: 'AR', no: '002', color: '#33608C', stage: 'plan',   blurb: 'Turns a task into a plan: files to touch, risks, test strategy.' },
  { id: 'backend',    code: 'BE', no: '003', color: '#276A4B', stage: 'build',  blurb: 'APIs, data layer and business logic.' },
  { id: 'frontend',   code: 'FE', no: '004', color: '#6C4A8C', stage: 'build',  blurb: 'UI, styling, client behavior, accessibility.' },
  { id: 'qa',         code: 'QA', no: '005', color: '#0F6B78', stage: 'test',   blurb: 'Runs the suite, writes tests, hunts bugs.' },
  { id: 'reviewer',   code: 'RV', no: '006', color: '#B3402A', stage: 'review', blurb: 'Read-only review of the diff: bugs, security, performance.' },
  { id: 'reporter',   code: 'RP', no: '007', color: '#4A4E42', stage: 'report', blurb: 'Files the final report into reports/.' },
  { id: 'explainer',  code: 'EX', no: '008', color: '#8A6D2F', stage: 'report', blurb: 'Reads the project end to end and files docs/PROJECT-GUIDE.md.' },
];

const AGENT_TO_STAGE = {
  dispatcher: 'intake',
  architect: 'plan',
  'architect-deep': 'plan',
  backend: 'build',
  'backend-deep': 'build',
  frontend: 'build',
  'frontend-deep': 'build',
  qa: 'test',
  'qa-deep': 'test',
  reviewer: 'review',
  'reviewer-deep': 'review',
  reporter: 'report',
  explainer: 'report',
};

const DEFAULT_AGY_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-4-argon-high',
  'gemini-4-argon-medium',
  'gemini-4-argon-low',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-low',
  'claude-opus-5-5-high',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-low',
  'gpt-oss-120b-medium',
];

// ---------- team preferences ----------
const AGY_PREFS_FILE = path.join(os.homedir(), '.gemini', 'config', 'ai-team-preferences.json');
const LEGACY_PREFS_FILE = path.join(os.homedir(), '.config', 'opencode', 'team-preferences.json');

function readPrefs() {
  for (const file of [AGY_PREFS_FILE, LEGACY_PREFS_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && typeof j === 'object') return j;
      }
    } catch { /* ignore */ }
  }
  return {};
}

function writePrefs(prefs) {
  for (const file of [AGY_PREFS_FILE, LEGACY_PREFS_FILE]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(prefs, null, 2));
    } catch { /* best effort */ }
  }
}

function prefsPayload() {
  const p = readPrefs();
  const engine = p.engine === 'opencode' ? 'opencode' : 'agy';
  const modelRouting = p.modelRouting === 'dynamic' ? 'dynamic' : 'static';
  const timeout = Number(p.inactivityTimeoutMin);
  const inactivityTimeoutMin = Number.isFinite(timeout) && timeout >= 1 && timeout <= 120 ? timeout : 10;
  const executionMode = p.executionMode === 'single' ? 'single' : 'phased';
  const phaseAdvance = p.phaseAdvance === 'manual' ? 'manual' : 'auto';
  const projectMemory = p.projectMemory === false ? false : true;
  const quotaAutoSwitch = p.quotaAutoSwitch === false ? false : true;
  const crossEngineFallback = p.crossEngineFallback === false ? false : true;
  const retries = Number(p.maxQuotaRetries);
  const maxQuotaRetries = Number.isFinite(retries) && retries >= 1 && retries <= 10 ? Math.round(retries) : 3;
  return {
    engine,
    modelRouting,
    inactivityTimeoutMin,
    executionMode,
    phaseAdvance,
    projectMemory,
    quotaAutoSwitch,
    crossEngineFallback,
    maxQuotaRetries,
    cooldowns: getActiveCooldowns(),
  };
}

function activeEngine() {
  return readPrefs().engine === 'opencode' ? 'opencode' : 'agy';
}

// ---------- quota detection & model cooldown management ----------
const modelCooldowns = new Map(); // key: "${engine}:${model}" -> { engine, model, until, reason }

const QUOTA_REGEX = /(?:RESOURCE_EXHAUSTED|quota\s+(?:exceeded|exhausted|limit|reached)|out\s+of\s+quota|insufficient_quota|exceeded\s+your\s+current\s+quota|rate[_\s-]limit(?:\s+exceeded|\s+reached)?|too\s+many\s+requests|\b(?:http|status|statusCode|code|error)[:\s=]+429\b|\b429\s+Too\s+Many\s+Requests\b|credit\s+balance\s+is\s+too\s+low|billing\s+hard\s+limit|model[_\s-]cooldown|capacity\s+exhausted|no\s+capacity\s+available|usage\s+limit\s+(?:exceeded|reached))/i;

function isQuotaError(text) {
  if (typeof text !== 'string' || !text) return false;
  if (text.length > 2400) return false;
  return QUOTA_REGEX.test(text);
}

function markModelCooldown(engine, model, reason = 'quota_exhausted', durationMs = 15 * 60 * 1000) {
  if (!engine || !model) return;
  const key = `${engine}:${model}`;
  modelCooldowns.set(key, {
    engine,
    model,
    reason: String(reason || 'quota_exhausted').slice(0, 160),
    until: Date.now() + durationMs,
  });
}

function isModelOnCooldown(engine, model) {
  const key = `${engine}:${model}`;
  const entry = modelCooldowns.get(key);
  if (!entry) return false;
  if (entry.until <= Date.now()) {
    modelCooldowns.delete(key);
    return false;
  }
  return true;
}

function getActiveCooldowns() {
  const now = Date.now();
  const active = [];
  for (const [k, v] of modelCooldowns.entries()) {
    if (v.until <= now) modelCooldowns.delete(k);
    else active.push({ ...v, remainingSec: Math.max(1, Math.round((v.until - now) / 1000)) });
  }
  return active;
}

function clearModelCooldowns() {
  modelCooldowns.clear();
}

async function selectFallbackModel(agentId, currentEngine, currentModel, prefs) {
  const baseId = String(agentId || 'dispatcher').replace(/-deep$/, '');
  const tryEngine = async (eng, excludeModel) => {
    const catalog = await getModelCatalog(eng);
    const ordered = [];
    if (eng === 'agy') {
      const pref = PREFERRED_AGY[baseId];
      if (pref && catalog.includes(pref)) ordered.push(pref);
      for (const m of catalog) {
        if (!ordered.includes(m)) ordered.push(m);
      }
    } else {
      const pref = PREFERRED_OPENCODE_FREE[baseId];
      if (pref && catalog.includes(pref)) ordered.push(pref);
      for (const m of catalog.filter(x => /-free$/i.test(x))) {
        if (!ordered.includes(m)) ordered.push(m);
      }
      for (const m of catalog) {
        if (!ordered.includes(m)) ordered.push(m);
      }
    }
    for (const candidate of ordered) {
      if (candidate === excludeModel) continue;
      if (!isModelOnCooldown(eng, candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const sameEnginePick = await tryEngine(currentEngine, currentModel);
  if (sameEnginePick) {
    return { engine: currentEngine, model: sameEnginePick, crossEngine: false };
  }
  if (prefs && prefs.crossEngineFallback) {
    const altEngine = currentEngine === 'agy' ? 'opencode' : 'agy';
    const altPick = await tryEngine(altEngine, null);
    if (altPick) {
      return { engine: altEngine, model: altPick, crossEngine: true };
    }
  }
  return null;
}

// ---------- persistent project memory & phased pipeline ----------
const PIPELINE_PHASES = [
  {
    id: 'plan',
    label: 'Plan',
    stage: 'plan',
    agent: 'architect',
    instructions: 'Phase 1 (PLAN): Analyze the repository and produce a concise, actionable implementation plan (Goal, Acceptance criteria, Files to create/modify, Design notes, Risks, Test strategy). Do NOT modify application code in this phase. Append your 1-line shift log to journal/architect.jsonl.',
  },
  {
    id: 'build',
    label: 'Build',
    stage: 'build',
    agent: 'backend',
    instructions: 'Phase 2 (BUILD): Implement all planned changes from Phase 1 in small, clean commits. Handle both backend and frontend files called for by the plan, and verify build/syntax. Append your 1-line shift log to journal/backend.jsonl (or journal/frontend.jsonl).',
  },
  {
    id: 'test',
    label: 'Test',
    stage: 'test',
    agent: 'qa',
    instructions: 'Phase 3 (TEST): Run the project test suite, add or update tests covering the new changes from Phase 2, and fix or report any failures. Append your 1-line shift log to journal/qa.jsonl.',
  },
  {
    id: 'review',
    label: 'Review',
    stage: 'review',
    agent: 'reviewer',
    instructions: 'Phase 4 (REVIEW): Perform a read-only code review of the current branch diff (correctness, security, performance, maintainability) and output your verdict. Append your 1-line shift log to journal/reviewer.jsonl.',
  },
  {
    id: 'report',
    label: 'Report',
    stage: 'report',
    agent: 'reporter',
    instructions: 'Phase 5 (REPORT): File the final stakeholder report in reports/YYYY-MM-DD-HHMM-<slug>.md using docs/report-template.md summarizing what shipped, test results, and review verdict. Append your 1-line shift log to journal/reporter.jsonl.',
  },
];

function resolveProjectDir(targetDir) {
  if (targetDir && typeof targetDir === 'string' && targetDir.trim()) {
    const resolved = path.resolve(targetDir.trim());
    if (path.isAbsolute(resolved) && isDir(resolved)) return resolved;
  }
  return ROOT;
}

function memoryFilePath(targetDir) {
  return path.join(resolveProjectDir(targetDir), '.ai-team', 'memory.json');
}

function memoryMarkdownPath(targetDir) {
  return path.join(resolveProjectDir(targetDir), 'docs', 'PROJECT-MEMORY.md');
}

function readProjectMemory(targetDir) {
  const file = memoryFilePath(targetDir);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch { /* ignore */ }
  return null;
}

function syncMemoryMarkdown(targetDir, mem) {
  if (!mem || !mem.originalTask) return;
  try {
    const mdPath = memoryMarkdownPath(targetDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const lines = [
      '# AI Team — Project Memory & Phase Handoff',
      '',
      `- **Task:** ${mem.originalTask}`,
      `- **Status:** ${mem.status || 'idle'} (${mem.executionMode || 'phased'})`,
      `- **Updated:** ${mem.updatedAt || new Date().toISOString()}`,
      `- **Last Engine / Model:** ${mem.lastEngine || '—'} · ${mem.lastModel || '—'}`,
      `- **Git Branch:** ${mem.gitBranch || '—'}`,
      '',
    ];
    if (mem.notes) {
      lines.push('## Principal Notes', '', mem.notes, '');
    }
    if (mem.planSummary) {
      lines.push('## Architectural Plan Summary', '', mem.planSummary, '');
    }
    if (Array.isArray(mem.phases) && mem.phases.length) {
      lines.push('## Pipeline Phases', '');
      mem.phases.forEach((p, idx) => {
        const icon = p.status === 'done' ? '✓' : p.status === 'running' ? '●' : p.status === 'failed' ? '✗' : '○';
        lines.push(`### ${idx + 1}. ${icon} ${p.label} (@${p.agent}) — \`${p.status}\``);
        if (p.engine || p.model) lines.push(`- **Executed on:** ${p.engine || '—'} / \`${p.model || '—'}\``);
        if (p.summary) lines.push(`- **Handoff Summary:** ${p.summary}`);
        lines.push('');
      });
    }
    if (Array.isArray(mem.changedFiles) && mem.changedFiles.length) {
      lines.push('## Modified Files in Working Tree', '');
      for (const f of mem.changedFiles.slice(0, 25)) lines.push(`- \`${f}\``);
      lines.push('');
    }
    if (Array.isArray(mem.recentCommits) && mem.recentCommits.length) {
      lines.push('## Recent Commits', '');
      for (const c of mem.recentCommits.slice(0, 8)) lines.push(`- \`${c}\``);
      lines.push('');
    }
    if (Array.isArray(mem.failovers) && mem.failovers.length) {
      lines.push('## Automatic Quota Failovers', '');
      for (const fo of mem.failovers) {
        lines.push(`- ${fo.ts}: @${fo.agent} switched from \`${fo.fromEngine}:${fo.fromModel}\` → \`${fo.toEngine}:${fo.toModel}\` (attempt ${fo.attempt})`);
      }
      lines.push('');
    }
    fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  } catch { /* best effort */ }
}

function writeProjectMemory(targetDir, mem) {
  const dir = resolveProjectDir(targetDir);
  const file = memoryFilePath(dir);
  const updated = { ...mem, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
    syncMemoryMarkdown(dir, updated);
  } catch { /* best effort */ }
  return updated;
}

function clearProjectMemory(targetDir) {
  const dir = resolveProjectDir(targetDir);
  try {
    const file = memoryFilePath(dir);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}

function pickBuildAgentForTask(task) {
  const t = String(task || '').toLowerCase();
  const uiSignals = /\b(ui|ux|css|html|style|styling|button|modal|layout|frontend|theme|color|font|responsive|accessibility|aria)\b/.test(t);
  const beSignals = /\b(api|endpoint|server|database|sql|schema|auth|cli|backend|process|stream|socket|cron|worker)\b/.test(t);
  if (uiSignals && !beSignals) return 'frontend';
  return 'backend';
}

function initProjectMemory(targetDir, task, executionMode = 'phased', assignedAgent = 'dispatcher') {
  const existing = readProjectMemory(targetDir);
  const now = new Date().toISOString();
  const buildAgent = pickBuildAgentForTask(task);
  const phases = PIPELINE_PHASES.map(p => ({
    id: p.id,
    label: p.label,
    stage: p.stage,
    agent: p.id === 'build' ? buildAgent : p.agent,
    instructions: p.instructions,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    engine: null,
    model: null,
    summary: '',
  }));
  const mem = {
    taskId: `mem-${Date.now()}`,
    originalTask: task,
    assignedAgent,
    executionMode,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    currentPhaseIndex: 0,
    lastEngine: activeEngine(),
    lastModel: null,
    gitBranch: existing?.gitBranch || 'main',
    changedFiles: existing?.changedFiles || [],
    recentCommits: existing?.recentCommits || [],
    planSummary: '',
    lastSummary: '',
    notes: existing?.notes || '',
    phases: executionMode === 'phased' ? phases : [],
    failovers: [],
  };
  return writeProjectMemory(targetDir, mem);
}

function buildMemoryHandoffPrompt(memory, phase, fallbackTask) {
  const rawTask = (memory && memory.originalTask) || fallbackTask || '';
  if (!memory) return rawTask;

  const parts = [
    '[AI TEAM PROJECT MEMORY & CONTINUATION BRIEF]',
    `Original Task: ${rawTask}`,
  ];
  if (phase) {
    const idx = Array.isArray(memory.phases) ? memory.phases.findIndex(p => p.id === phase.id) : 0;
    parts.push(`Current Pipeline Phase: Phase ${idx + 1}/${memory.phases.length || 5} — ${phase.label.toUpperCase()} (assigned to @${phase.agent})`);
  }
  if (memory.gitBranch) {
    parts.push(`Git Branch: ${memory.gitBranch}`);
  }
  if (Array.isArray(memory.changedFiles) && memory.changedFiles.length) {
    parts.push(`Modified Files in Working Tree: ${memory.changedFiles.slice(0, 20).join(', ')}`);
  }
  if (Array.isArray(memory.recentCommits) && memory.recentCommits.length) {
    parts.push(`Recent Git Commits: ${memory.recentCommits.slice(0, 5).join(' | ')}`);
  }
  if (memory.notes && memory.notes.trim()) {
    parts.push(`\n--- Principal Notes ---\n${memory.notes.trim()}`);
  }
  if (memory.planSummary && memory.planSummary.trim() && (!phase || phase.id !== 'plan')) {
    parts.push(`\n--- Architectural Plan (from Phase 1) ---\n${memory.planSummary.trim()}`);
  }
  if (Array.isArray(memory.phases) && memory.phases.length) {
    const completed = memory.phases.filter(p => p.status === 'done' && p.summary);
    if (completed.length) {
      parts.push('\n--- Completed Phases ---');
      for (const cp of completed) {
        parts.push(`- [${cp.label}] (@${cp.agent} via ${cp.engine || 'cli'}/${cp.model || 'model'}): ${cp.summary}`);
      }
    }
  } else if (memory.lastSummary) {
    parts.push(`\n--- Previous Run Progress ---\n${memory.lastSummary}`);
  }

  if (phase) {
    parts.push(`\n--- YOUR ASSIGNMENT FOR THIS PHASE (${phase.label.toUpperCase()}) ---`);
    parts.push(phase.instructions);
    parts.push('Continue seamlessly from the repository state and memory above. You may also inspect docs/PROJECT-MEMORY.md if needed.');
  } else {
    parts.push('\n--- CONTINUATION INSTRUCTIONS ---');
    parts.push('Continue and complete the Original Task from the current repository state above without redoing work that is already committed.');
  }
  return parts.join('\n');
}

// ---------- safe line-buffered stream splitter ----------
function createLineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  return {
    write(chunk) {
      remainder += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    },
    end() {
      remainder += decoder.end();
      const trimmed = remainder.trim();
      remainder = '';
      if (trimmed) onLine(trimmed);
    },
  };
}

// ---------- in-memory run state ----------
const runs = new Map(); // id → run object
let runCounter = 0;

function pushEvent(run, event) {
  const enriched = { ts: new Date().toISOString(), ...event };
  run.events.push(enriched);
  if (run.events.length > MAX_EVENTS_PER_RUN) run.events.shift();
  const msg = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const res of run.clients) {
    try { res.write(msg); } catch { /* client gone */ }
  }
}

function setRunStage(run, stage, status = 'lit', agent = null) {
  if (!stage) return;
  const order = ['intake', 'plan', 'build', 'test', 'review', 'report'];
  const idx = order.indexOf(stage);
  if (idx >= 0 && status === 'lit') {
    for (let i = 0; i < idx; i++) {
      const prev = order[i];
      if (run.stages[prev] === 'lit') {
        run.stages[prev] = 'done';
      }
    }
  }
  if (run.stages[stage] === status) return;
  run.stages[stage] = status;
  pushEvent(run, { kind: 'stage', stage, status, agent: agent || run.agent, stages: { ...run.stages } });
}

function detectStageTransitionFromEvent(run, parsed, rawText) {
  const str = rawText || JSON.stringify(parsed || {});
  // Detect subagent invocation or @mention handoff
  const subMatch = str.match(/(?:TypeName|subagent|agent)["'\s:=]+["']?(architect(?:-deep)?|backend(?:-deep)?|frontend(?:-deep)?|qa(?:-deep)?|reviewer(?:-deep)?|reporter|explainer)["']?/i)
    || str.match(/@(architect(?:-deep)?|backend(?:-deep)?|frontend(?:-deep)?|qa(?:-deep)?|reviewer(?:-deep)?|reporter|explainer)\b/i);
  if (subMatch) {
    const targetAgent = subMatch[1].toLowerCase().replace(/-deep$/, '');
    const st = AGENT_TO_STAGE[targetAgent];
    if (st) setRunStage(run, st, 'lit', targetAgent);
  }
  // Detect writes to reports/ or journal/
  if (/reports[\\/]\d{4}-\d{2}-\d{2}/i.test(str)) {
    setRunStage(run, 'report', 'lit', 'reporter');
  }
}

function sseSend(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function snapshotJournalCounts(cwd) {
  const counts = {};
  const journalDir = path.join(cwd, 'journal');
  if (!fs.existsSync(journalDir)) return counts;
  for (const slot of ROSTER) {
    try {
      const p = path.join(journalDir, slot.id + '.jsonl');
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        counts[slot.id] = lines.length;
      }
    } catch { /* ignore */ }
  }
  return counts;
}

function startRun({ task, agent, dir, resume = false, startPhaseIndex = null }) {
  const id = `run-${Date.now()}-${++runCounter}`;
  const cwd = dir && dir.trim() ? path.resolve(dir.trim()) : ROOT;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const prefs = prefsPayload();
  const existingMem = readProjectMemory(cwd);
  if (resume && (!existingMem || !existingMem.originalTask)) {
    throw new Error('No saved task in project memory for this folder — dispatch a task first.');
  }

  const effectiveTask = resume ? existingMem.originalTask : task;
  const effectiveAgent = resume ? (existingMem.assignedAgent || agent || 'dispatcher') : (agent || 'dispatcher');
  const baseAgentId = String(effectiveAgent).replace(/-deep$/, '');
  const isPhased = resume
    ? (existingMem.executionMode === 'phased' && Array.isArray(existingMem.phases) && existingMem.phases.length > 0)
    : (baseAgentId === 'dispatcher' && prefs.executionMode === 'phased');

  let memory = null;
  if (resume) {
    memory = { ...existingMem, status: 'running' };
    if (isPhased) {
      let idx = typeof startPhaseIndex === 'number' ? startPhaseIndex : (memory.currentPhaseIndex || 0);
      if (idx < 0 || idx >= memory.phases.length) {
        const firstIncomplete = memory.phases.findIndex(p => p.status !== 'done');
        idx = firstIncomplete >= 0 ? firstIncomplete : 0;
      }
      memory.currentPhaseIndex = idx;
      if (memory.phases[idx]) {
        memory.phases[idx].status = 'pending';
      }
    }
    memory = writeProjectMemory(cwd, memory);
  } else if (prefs.projectMemory) {
    memory = initProjectMemory(cwd, effectiveTask, isPhased ? 'phased' : 'single', effectiveAgent);
  }

  const engine = prefs.engine;
  const meta = getEffectiveAgentMeta(effectiveAgent);

  const initialStages = { intake: 'lit', plan: 'idle', build: 'idle', test: 'idle', review: 'idle', report: 'idle' };
  if (isPhased && memory && Array.isArray(memory.phases)) {
    initialStages.intake = 'done';
    for (let i = 0; i < memory.phases.length; i++) {
      const p = memory.phases[i];
      if (i < memory.currentPhaseIndex || p.status === 'done') initialStages[p.stage] = 'done';
      else if (i === memory.currentPhaseIndex) initialStages[p.stage] = 'lit';
    }
  } else if (baseAgentId !== 'dispatcher' && AGENT_TO_STAGE[baseAgentId]) {
    initialStages.intake = 'done';
    initialStages[AGENT_TO_STAGE[baseAgentId]] = 'lit';
  }

  const run = {
    id,
    task: effectiveTask,
    agent: effectiveAgent,
    dir: cwd,
    engine,
    model: meta.model || null,
    isPhased,
    phaseIndex: isPhased && memory ? (memory.currentPhaseIndex || 0) : 0,
    pauseRequested: false,
    retryCount: 0,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    error: null,
    stopRequested: false,
    timedOut: false,
    stages: initialStages,
    events: [],
    clients: new Set(),
    child: null,
    watchdog: null,
    journalTimer: null,
  };

  // Inactivity watchdog
  const resetWatchdog = () => {
    if (run.watchdog) clearTimeout(run.watchdog);
    if (run.status !== 'running') return;
    const curPrefs = prefsPayload();
    const timeoutMs = (curPrefs.inactivityTimeoutMin || 10) * 60 * 1000;
    run.watchdog = setTimeout(() => {
      if (run.status === 'running') {
        run.timedOut = true;
        pushEvent(run, {
          kind: 'raw',
          stream: 'stderr',
          text: `⏱ Run timed out after ${curPrefs.inactivityTimeoutMin}m of inactivity — halting process.`,
        });
        stopRun(run);
      }
    }, timeoutMs);
  };

  // Poll journal directory every 2s during active run to detect real stage completions
  const knownJournals = snapshotJournalCounts(cwd);
  const latestJournalByAgent = {};
  run.journalTimer = setInterval(() => {
    const journalDir = path.join(cwd, 'journal');
    if (!fs.existsSync(journalDir)) return;
    for (const slot of ROSTER) {
      try {
        const p = path.join(journalDir, slot.id + '.jsonl');
        if (!fs.existsSync(p)) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        const prevCount = knownJournals[slot.id] || 0;
        if (lines.length > prevCount) {
          knownJournals[slot.id] = lines.length;
          const latestRaw = lines[lines.length - 1];
          let parsedEntry = null;
          try { parsedEntry = JSON.parse(latestRaw); } catch { /* ignore */ }
          const st = AGENT_TO_STAGE[slot.id];
          if (st && !run.isPhased) {
            setRunStage(run, st, parsedEntry && parsedEntry.status === 'failed' ? 'failed' : 'done', slot.id);
          }
          if (parsedEntry) {
            latestJournalByAgent[slot.id] = parsedEntry;
            pushEvent(run, { kind: 'journal', agent: slot.id, entry: parsedEntry });
          }
        }
      } catch { /* ignore */ }
    }
  }, 2000);

  let runFinalized = false;
  const finalizeRun = (finalStatus, code, signal, errText) => {
    if (runFinalized) return;
    runFinalized = true;
    if (run.watchdog) { clearTimeout(run.watchdog); run.watchdog = null; }
    if (run.journalTimer) { clearInterval(run.journalTimer); run.journalTimer = null; }

    run.endedAt = new Date().toISOString();
    run.exitCode = typeof code === 'number' ? code : null;
    run.status = finalStatus;
    if (errText) run.error = errText;

    for (const k of Object.keys(run.stages)) {
      if (run.stages[k] === 'lit') {
        if (finalStatus === 'done') run.stages[k] = 'done';
        else if (finalStatus === 'paused' || finalStatus === 'stopped') run.stages[k] = 'idle';
        else run.stages[k] = 'failed';
      }
    }
    if (finalStatus === 'done' && baseAgentId === 'dispatcher') {
      for (const k of Object.keys(run.stages)) run.stages[k] = 'done';
    }

    pushEvent(run, {
      kind: 'status',
      status: run.status,
      exitCode: run.exitCode,
      error: run.error,
      endedAt: run.endedAt,
      stages: { ...run.stages },
    });

    appendMetric({
      id: run.id,
      agent: run.agent,
      dir: run.dir,
      engine: run.engine,
      task: String(run.task || '').slice(0, 500),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: Math.max(0, new Date(run.endedAt) - new Date(run.startedAt)),
      status: run.status === 'paused' ? 'done' : run.status,
      exitCode: run.exitCode,
      signal: run.status === 'stopped' ? (signal || null) : undefined,
      eventCount: run.events.length,
    });

    for (const res of run.clients) { try { res.end(); } catch {} }
    run.clients.clear();
  };

  const launchStep = () => {
    if (runFinalized || run.stopRequested) {
      finalizeRun('stopped', null, null, null);
      return;
    }

    const curPrefs = prefsPayload();
    if (memory) {
      const diskMem = readProjectMemory(cwd);
      if (diskMem && diskMem.taskId === memory.taskId) memory = diskMem;
    }

    let currentPhase = null;
    let stepAgent = run.agent;
    if (run.isPhased && memory && Array.isArray(memory.phases)) {
      currentPhase = memory.phases[run.phaseIndex];
      if (!currentPhase) {
        memory.status = 'completed';
        writeProjectMemory(cwd, memory);
        finalizeRun('done', 0, null, null);
        return;
      }
      stepAgent = currentPhase.agent || 'backend';
      // Dynamic routing upgrade on hard tasks
      if (
        curPrefs.modelRouting === 'dynamic' &&
        ['architect', 'backend', 'frontend', 'qa', 'reviewer'].includes(stepAgent) &&
        (run.task.length > 220 || /\b(architecture|security|refactor|migrate|multi-module|concurrency|auth|failover)\b/i.test(run.task))
      ) {
        const deepCandidate = `${stepAgent}-deep`;
        if (knownAgentIds().has(deepCandidate)) stepAgent = deepCandidate;
      }
    }

    const baseStepAgent = String(stepAgent).replace(/-deep$/, '');
    const stepEngine = curPrefs.engine;
    const stepMeta = getEffectiveAgentMeta(stepAgent);
    const stepModel = stepMeta.model || null;
    run.engine = stepEngine;
    run.model = stepModel;

    if (currentPhase) {
      run.stages.intake = 'done';
      setRunStage(run, currentPhase.stage, 'lit', baseStepAgent);
      currentPhase.status = 'running';
      currentPhase.startedAt = new Date().toISOString();
      currentPhase.engine = stepEngine;
      currentPhase.model = stepModel;
      memory.currentPhaseIndex = run.phaseIndex;
      memory.status = 'running';
      memory.lastEngine = stepEngine;
      memory.lastModel = stepModel;
      memory = writeProjectMemory(cwd, memory);
      pushEvent(run, {
        kind: 'phase',
        phase: currentPhase.id,
        label: currentPhase.label,
        index: run.phaseIndex,
        total: memory.phases.length,
        status: 'running',
        agent: stepAgent,
        engine: stepEngine,
        model: stepModel,
        memory,
      });
    } else if (memory) {
      memory.lastEngine = stepEngine;
      memory.lastModel = stepModel;
      memory.status = 'running';
      memory = writeProjectMemory(cwd, memory);
    }

    const stepPrompt = (curPrefs.projectMemory && memory && (run.isPhased || resume || run.retryCount > 0 || memory.notes))
      ? buildMemoryHandoffPrompt(memory, currentPhase, run.task)
      : run.task;

    let bin;
    let args;
    if (stepEngine === 'agy') {
      bin = AGY_BIN;
      args = [
        '--print',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--mode', 'auto',
        '--agent', stepAgent,
      ];
      if (stepModel && !stepModel.startsWith('opencode/')) {
        args.push('--model', stepModel);
      }
      if (stepMeta.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(stepMeta.effort)) {
        args.push('--effort', stepMeta.effort);
      }
      args.push(stepPrompt);
    } else {
      bin = OPENCODE_BIN;
      args = ['run', '--standalone', '--format', 'json', '--auto', '--agent', stepAgent, '--title', `hq:${id}`, stepPrompt];
    }

    const stepAssistantTexts = [];
    const stepRecentLines = [];
    let stepQuotaDetected = false;
    let stepQuotaReason = '';
    delete latestJournalByAgent[baseStepAgent];

    const recordRecentLine = (txt) => {
      if (!txt) return;
      stepRecentLines.push(String(txt).slice(0, 600));
      if (stepRecentLines.length > 20) stepRecentLines.shift();
    };

    const handleParsedLine = (trimmed, stream) => {
      resetWatchdog();
      recordRecentLine(trimmed);
      if (stream === 'stderr' && isQuotaError(trimmed)) {
        stepQuotaDetected = true;
        stepQuotaReason = trimmed;
      }
      let ev;
      try {
        const parsed = JSON.parse(trimmed);
        ev = { kind: 'json', stream, event: parsed };
        const evType = String(parsed.event ?? parsed.type ?? parsed.kind ?? '').toLowerCase();
        if ((evType === 'error' || parsed.error) && isQuotaError(trimmed)) {
          stepQuotaDetected = true;
          stepQuotaReason = trimmed;
        }
        const txt = parsed?.part?.text ?? parsed?.output ?? parsed?.text ?? parsed?.message ?? parsed?.content ?? null;
        if (typeof txt === 'string' && txt.trim()) {
          stepAssistantTexts.push(txt.trim());
          recordRecentLine(txt.trim());
        }
        if (!run.isPhased) detectStageTransitionFromEvent(run, parsed, trimmed);
      } catch {
        ev = { kind: 'raw', stream, text: trimmed };
        if (!run.isPhased) detectStageTransitionFromEvent(run, null, trimmed);
      }
      pushEvent(run, ev);
    };

    const stdoutSplitter = createLineSplitter(line => handleParsedLine(line, 'stdout'));
    const stderrSplitter = createLineSplitter(line => handleParsedLine(line, 'stderr'));

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      finalizeRun('error', null, null, String(spawnErr.message || spawnErr));
      return;
    }

    run.child = child;
    if (child.stdin) child.stdin.end();
    resetWatchdog();

    child.stdout.on('data', d => stdoutSplitter.write(d));
    child.stderr.on('data', d => stderrSplitter.write(d));

    let stepClosed = false;
    const onStepClose = async (code, signal, spawnErr) => {
      if (stepClosed || runFinalized) return;
      stepClosed = true;
      stdoutSplitter.end();
      stderrSplitter.end();

      const gitInfo = await getGitStatus(cwd);
      const journalEntry = latestJournalByAgent[baseStepAgent];
      const rawAssistant = stepAssistantTexts.join('\n').trim();
      const stepSummary = (journalEntry && journalEntry.summary)
        ? journalEntry.summary
        : (rawAssistant ? rawAssistant.slice(-600) : '');
      const stepFullPlan = rawAssistant ? rawAssistant.slice(-3500) : stepSummary;

      if (run.stopRequested && !run.timedOut) {
        if (memory) {
          memory.status = 'paused';
          memory.gitBranch = gitInfo.branch || memory.gitBranch;
          memory.changedFiles = (gitInfo.changedFiles || []).map(f => f.file);
          memory.recentCommits = (gitInfo.commits || []).map(c => `${c.hash} ${c.subject}`);
          if (currentPhase && currentPhase.status === 'running') {
            currentPhase.status = 'pending';
            if (stepSummary) currentPhase.summary = stepSummary;
          }
          memory = writeProjectMemory(cwd, memory);
        }
        finalizeRun('stopped', code, signal, null);
        return;
      }

      const latestPrefs = prefsPayload();
      const hitQuota = stepQuotaDetected || (code !== 0 && stepRecentLines.some(l => isQuotaError(l)));

      // Automatic Quota Failover & Continuation
      if (hitQuota && latestPrefs.quotaAutoSwitch && run.retryCount < latestPrefs.maxQuotaRetries && !run.stopRequested) {
        run.retryCount += 1;
        markModelCooldown(stepEngine, stepModel, stepQuotaReason || 'quota_exhausted');
        const fb = await selectFallbackModel(baseStepAgent, stepEngine, stepModel, latestPrefs);
        if (fb) {
          if (fb.crossEngine) {
            writePrefs({ ...readPrefs(), engine: fb.engine });
          }
          try { await setAgentModel(baseStepAgent, fb.model); } catch { /* best effort */ }
          if (memory) {
            memory.gitBranch = gitInfo.branch || memory.gitBranch;
            memory.changedFiles = (gitInfo.changedFiles || []).map(f => f.file);
            memory.recentCommits = (gitInfo.commits || []).map(c => `${c.hash} ${c.subject}`);
            if (stepSummary) memory.lastSummary = stepSummary;
            memory.failovers = memory.failovers || [];
            memory.failovers.push({
              ts: new Date().toISOString(),
              agent: baseStepAgent,
              phase: currentPhase ? currentPhase.id : null,
              fromEngine: stepEngine,
              fromModel: stepModel,
              toEngine: fb.engine,
              toModel: fb.model,
              attempt: run.retryCount,
            });
            memory = writeProjectMemory(cwd, memory);
          }
          pushEvent(run, {
            kind: 'failover',
            agent: baseStepAgent,
            phase: currentPhase ? currentPhase.id : null,
            fromEngine: stepEngine,
            fromModel: stepModel,
            toEngine: fb.engine,
            toModel: fb.model,
            crossEngine: fb.crossEngine,
            attempt: run.retryCount,
            maxRetries: latestPrefs.maxQuotaRetries,
          });
          launchStep();
          return;
        }
      }

      // Step succeeded
      if (code === 0 && !hitQuota && !spawnErr && !run.timedOut) {
        run.retryCount = 0;
        if (run.isPhased && memory && currentPhase) {
          currentPhase.status = 'done';
          currentPhase.endedAt = new Date().toISOString();
          currentPhase.summary = stepSummary || `Completed ${currentPhase.label} phase.`;
          if (currentPhase.id === 'plan' && stepFullPlan) {
            memory.planSummary = stepFullPlan;
          }
          memory.gitBranch = gitInfo.branch || memory.gitBranch;
          memory.changedFiles = (gitInfo.changedFiles || []).map(f => f.file);
          memory.recentCommits = (gitInfo.commits || []).map(c => `${c.hash} ${c.subject}`);
          setRunStage(run, currentPhase.stage, 'done', baseStepAgent);

          run.phaseIndex += 1;
          memory.currentPhaseIndex = run.phaseIndex;

          if (run.phaseIndex < memory.phases.length) {
            const nextPhase = memory.phases[run.phaseIndex];
            if (latestPrefs.phaseAdvance === 'manual' || run.pauseRequested) {
              memory.status = 'paused';
              memory = writeProjectMemory(cwd, memory);
              pushEvent(run, {
                kind: 'phase',
                phase: currentPhase.id,
                label: currentPhase.label,
                status: 'paused',
                nextPhase: nextPhase.id,
                nextLabel: nextPhase.label,
                memory,
              });
              finalizeRun('paused', 0, null, null);
              return;
            }
            memory.status = 'running';
            memory = writeProjectMemory(cwd, memory);
            pushEvent(run, {
              kind: 'phase',
              phase: currentPhase.id,
              label: currentPhase.label,
              status: 'done',
              nextPhase: nextPhase.id,
              nextLabel: nextPhase.label,
              memory,
            });
            launchStep();
            return;
          }

          // All phases complete
          memory.status = 'completed';
          memory = writeProjectMemory(cwd, memory);
          pushEvent(run, {
            kind: 'phase',
            phase: currentPhase.id,
            label: currentPhase.label,
            status: 'done',
            memory,
          });
          finalizeRun('done', 0, null, null);
          return;
        }

        // Single-run mode succeeded
        if (memory) {
          memory.status = 'completed';
          memory.lastSummary = stepSummary || 'Completed run.';
          memory.gitBranch = gitInfo.branch || memory.gitBranch;
          memory.changedFiles = (gitInfo.changedFiles || []).map(f => f.file);
          memory.recentCommits = (gitInfo.commits || []).map(c => `${c.hash} ${c.subject}`);
          memory = writeProjectMemory(cwd, memory);
        }
        finalizeRun('done', 0, null, null);
        return;
      }

      // Step failed and could not recover
      const errMsg = run.timedOut
        ? `Timed out after ${latestPrefs.inactivityTimeoutMin}m of inactivity`
        : spawnErr
          ? String(spawnErr.message || spawnErr)
          : hitQuota
            ? `Quota exhausted on ${stepEngine}:${stepModel} (retries exhausted)`
            : signal
              ? `Terminated by signal ${signal}`
              : `Process exited with code ${code}`;

      if (memory) {
        memory.status = 'paused';
        if (stepSummary) memory.lastSummary = stepSummary;
        memory.gitBranch = gitInfo.branch || memory.gitBranch;
        memory.changedFiles = (gitInfo.changedFiles || []).map(f => f.file);
        memory.recentCommits = (gitInfo.commits || []).map(c => `${c.hash} ${c.subject}`);
        if (currentPhase) {
          currentPhase.status = 'failed';
          currentPhase.endedAt = new Date().toISOString();
          currentPhase.summary = stepSummary || errMsg;
        }
        memory = writeProjectMemory(cwd, memory);
        if (currentPhase) {
          pushEvent(run, { kind: 'phase', phase: currentPhase.id, label: currentPhase.label, status: 'failed', error: errMsg, memory });
        }
      }
      finalizeRun(signal && !run.timedOut ? 'stopped' : 'error', code, signal, errMsg);
    };

    child.on('error', (err) => onStepClose(null, null, err));
    child.on('close', (code, signal) => onStepClose(code, signal, null));
  };

  runs.set(id, run);
  try {
    const key = normalizePathKey(cwd);
    const list = readRegistry();
    const i = list.findIndex(p => normalizePathKey(p && p.path) === key);
    if (i >= 0) { list[i].lastUsed = new Date().toISOString(); writeRegistry(list); }
  } catch { /* not a registered project */ }

  if (runs.size > MAX_RUNS_KEPT) {
    let victim = null;
    for (const r of runs.values()) {
      if (r.status !== 'running') { victim = r.id; break; }
    }
    if (victim) runs.delete(victim);
  }

  pushEvent(run, {
    kind: 'status',
    status: 'running',
    agent: run.agent,
    engine: run.engine,
    model: run.model,
    dir: run.dir,
    isPhased: run.isPhased,
    stages: { ...run.stages },
  });

  launchStep();
  return run;
}

function stopRun(run) {
  if (!run || run.status !== 'running') return false;
  run.stopRequested = true;
  if (!run.child || !run.child.pid) return true;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) { try { run.child.kill(); } catch { /* best effort */ } }
    });
  } else {
    try { run.child.kill('SIGTERM'); } catch { /* best effort */ }
  }
  return true;
}

// ---------- safe agent frontmatter & config comment parsing ----------
function parseAgentFileAt(dir, file) {
  const name = path.basename(file, '.md');
  let content = '';
  try { content = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const grabFm = (key) => {
    const r = new RegExp(`^${key}:\\s*(.+)$`, 'im').exec(fm);
    return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  // Also parse <!-- ai-team-config: model=... effort=... mode=... -->
  const cfgMatch = content.match(/<!--\s*ai-team-config:\s*([^>]+?)-->/i);
  const cfgStr = cfgMatch ? cfgMatch[1] : '';
  const grabCfg = (key) => {
    const r = new RegExp(`\\b${key}=([^\\s>]+)`, 'i').exec(cfgStr);
    return r ? r[1].trim() : null;
  };

  return {
    id: name,
    description: grabFm('description'),
    mode: grabCfg('mode') || grabFm('mode') || (name === 'dispatcher' ? 'primary' : 'subagent'),
    model: grabCfg('model') || grabFm('model') || null,
    effort: (grabCfg('effort') || grabFm('reasoningEffort') || 'default').toLowerCase(),
  };
}

function getEffectiveAgentMeta(id) {
  const engine = activeEngine();
  const dirs = engine === 'agy'
    ? [AGY_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR, OPENCODE_AGENTS_DIR, GLOBAL_OPENCODE_AGENTS_DIR]
    : [OPENCODE_AGENTS_DIR, GLOBAL_OPENCODE_AGENTS_DIR, AGY_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR];

  let description = '';
  let mode = id === 'dispatcher' ? 'primary' : 'subagent';
  let model = null;
  let effort = 'default';
  let localModel = null;
  let globalModel = null;

  const localDirs = engine === 'agy' ? [AGY_AGENTS_DIR, OPENCODE_AGENTS_DIR] : [OPENCODE_AGENTS_DIR, AGY_AGENTS_DIR];
  const globalDirs = engine === 'agy' ? [GLOBAL_AGY_PLUGIN_AGENTS_DIR, GLOBAL_OPENCODE_AGENTS_DIR] : [GLOBAL_OPENCODE_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR];

  for (const d of localDirs) {
    const p = parseAgentFileAt(d, id + '.md');
    if (p && p.model && !localModel) localModel = p.model;
  }
  for (const d of globalDirs) {
    const p = parseAgentFileAt(d, id + '.md');
    if (p && p.model && !globalModel) globalModel = p.model;
  }

  for (const d of dirs) {
    const p = parseAgentFileAt(d, id + '.md');
    if (!p) continue;
    if (!description && p.description) description = p.description;
    if (p.mode) mode = p.mode;
    if (!model && p.model) model = p.model;
    if (effort === 'default' && p.effort && p.effort !== 'default') effort = p.effort;
  }

  return { id, description, mode, model: model || 'gemini-3.8-flash-high', localModel, globalModel, effort };
}

function knownAgentIds() {
  const ids = new Set(ROSTER.map(s => s.id));
  for (const dir of [AGY_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR, OPENCODE_AGENTS_DIR, GLOBAL_OPENCODE_AGENTS_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) ids.add(path.basename(f, '.md'));
      }
    } catch { /* dir may not exist */ }
  }
  return ids;
}

// ---------- model catalog & vitals ----------
let modelCatalogCache = { agy: { at: 0, list: [...DEFAULT_AGY_MODELS], inflight: null }, opencode: { at: 0, list: [], inflight: null } };
let consoleVitalsCache = { at: 0, value: null, has: false, inflight: null };

function fetchAgyModels() {
  return new Promise((resolve) => {
    execFile(AGY_BIN, ['models'], { encoding: 'utf8', timeout: 12000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(modelCatalogCache.agy.list); return; }
      const parsed = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^([a-z0-9][a-z0-9._-]*)\t+(.+)$/i);
        if (m) parsed.push(m[1].trim());
      }
      const list = parsed.length ? [...new Set(parsed)] : modelCatalogCache.agy.list;
      modelCatalogCache.agy.list = list;
      modelCatalogCache.agy.at = Date.now();
      resolve(list);
    });
  });
}

function fetchOpencodeModels() {
  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, ['models'], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(modelCatalogCache.opencode.list); return; }
      const list = [...new Set(
        String(stdout || '').split('\n').map(s => s.trim()).filter(l => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(l))
      )];
      if (list.length) { modelCatalogCache.opencode.list = list; modelCatalogCache.opencode.at = Date.now(); }
      resolve(modelCatalogCache.opencode.list);
    });
  });
}

function getModelCatalog(engineOverride) {
  const engine = engineOverride || activeEngine();
  const bucket = engine === 'opencode' ? modelCatalogCache.opencode : modelCatalogCache.agy;
  const FRESH = 10 * 60 * 1000;
  const now = Date.now();
  if (bucket.list.length && (now - bucket.at < FRESH)) {
    return Promise.resolve(bucket.list);
  }
  if (bucket.inflight) return bucket.inflight;
  const fetcher = engine === 'opencode' ? fetchOpencodeModels : fetchAgyModels;
  const p = fetcher().finally(() => { bucket.inflight = null; });
  bucket.inflight = p;
  return p;
}

function fetchConsoleVitals() {
  const engine = activeEngine();
  if (engine === 'agy') {
    const m = metricsSummary();
    return Promise.resolve({
      engine: 'Antigravity (agy)',
      sessions: String(m.total || 0),
      subagents: String(ROSTER.length),
      prompts: String(m.done || 0),
      steps: m.avgDurationMs ? `${Math.round(m.avgDurationMs / 1000)}s avg` : '0s avg',
      tokens: 'Individual ($0)',
      toolSuccess: m.successRate != null ? `${m.successRate}%` : '100%',
    });
  }
  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, ['stats'], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
      const grab = re => { const m = out.match(re); return m ? m[1].trim() : null; };
      resolve({
        engine: 'OpenCode',
        sessions: grab(/(\d+[\d,.]*)\s*sessions/i),
        subagents: grab(/(\d+[\d,.]*)\s*subagents/i),
        prompts: grab(/(\d+[\d,.]*)\s*prompts/i),
        steps: grab(/([\d.km]+)\s*steps/i),
        tokens: grab(/([\d.km]+)\s*tokens/i),
        toolSuccess: grab(/([\d.]+%)\s*tool success/i),
      });
    });
  });
}

function consoleVitals() {
  const engine = activeEngine();
  if (engine === 'agy') return fetchConsoleVitals();
  const FRESH = 5 * 60 * 1000;
  const now = Date.now();
  if (consoleVitalsCache.has && (now - consoleVitalsCache.at < FRESH)) {
    return Promise.resolve(consoleVitalsCache.value);
  }
  if (!consoleVitalsCache.inflight) {
    consoleVitalsCache.inflight = fetchConsoleVitals().then(v => {
      consoleVitalsCache.value = v;
      consoleVitalsCache.has = true;
      consoleVitalsCache.at = Date.now();
      return v;
    }).catch(() => null).finally(() => { consoleVitalsCache.inflight = null; });
  }
  return consoleVitalsCache.has ? Promise.resolve(consoleVitalsCache.value) : consoleVitalsCache.inflight;
}

function agentUsage(targetDir) {
  const per = {};
  for (const r of readMetrics(targetDir)) {
    const a = per[r.agent] = per[r.agent] || { total: 0, done: 0, totalMs: 0 };
    a.total += 1;
    if (r.status === 'done') a.done += 1;
    a.totalMs += r.durationMs || 0;
  }
  return per;
}

async function agentSettingsPayload() {
  const engine = activeEngine();
  const catalog = await getModelCatalog(engine);
  const free = id => engine === 'agy' ? true : /-free$/i.test(id);
  const usage = agentUsage();
  return {
    engine,
    catalog,
    consoleVitals: await consoleVitals(),
    agents: ROSTER.map(slot => {
      const meta = getEffectiveAgentMeta(slot.id);
      return {
        id: slot.id, code: slot.code, no: slot.no, color: slot.color,
        blurb: slot.blurb,
        localModel: meta.localModel,
        globalModel: meta.globalModel,
        effectiveModel: meta.model,
        usage: usage[slot.id] || { total: 0, done: 0, totalMs: 0 },
        effort: meta.effort || 'default',
      };
    }),
    freeOnly: catalog.filter(free),
  };
}

// ---------- safe frontmatter & config comment writers ----------
function updateAgyConfigComment(fileContent, updates) {
  let content = fileContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const existingMatch = content.match(/<!--\s*ai-team-config:\s*([^>]+?)-->/i);
  const kv = { model: 'gemini-3.8-flash-high', effort: 'medium', mode: 'subagent' };
  if (existingMatch) {
    for (const part of existingMatch[1].trim().split(/\s+/)) {
      const eq = part.indexOf('=');
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === '' || v == null) delete kv[k];
    else kv[k] = v;
  }
  const newComment = `<!-- ai-team-config: ${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(' ')} -->`;
  if (existingMatch) {
    return content.replace(/<!--\s*ai-team-config:\s*[^>]+?-->/i, newComment);
  }
  return content.replace(/^(---\n[\s\S]*?\n---)\n?/, `$1\n${newComment}\n`);
}

function updateOpencodeFrontmatter(fileContent, key, value) {
  let content = fileContent.replace(/^\uFEFF/, '');
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return content;
  const nl = fmMatch[1].includes('\r\n') ? '\r\n' : '\n';
  const lines = fmMatch[2].split(/\r?\n/);
  const keyRe = new RegExp(`^${key}:\\s*`, 'i');
  const filtered = lines.filter(l => !keyRe.test(l));
  if (value !== '' && value != null) {
    const modelIdx = filtered.findIndex(l => /^model:\s*/i.test(l));
    if (key === 'reasoningEffort' && modelIdx >= 0) {
      filtered.splice(modelIdx + 1, 0, `${key}: ${value}`);
    } else if (key === 'model') {
      const modeIdx = filtered.findIndex(l => /^mode:\s*/i.test(l));
      filtered.splice(modeIdx >= 0 ? modeIdx + 1 : filtered.length, 0, `model: ${value}`);
    } else {
      filtered.push(`${key}: ${value}`);
    }
  }
  const newFm = `${fmMatch[1]}${filtered.join(nl)}${fmMatch[3]}`;
  return newFm + content.slice(fmMatch[0].length);
}

const EFFORT_LEVELS = ['low', 'medium', 'high'];

function setAgentEffort(id, effort) {
  if (!ROSTER.some(s => s.id === id)) throw new Error(`unknown employee: ${id}`);
  const level = String(effort || '').toLowerCase();
  if (level && !EFFORT_LEVELS.includes(level)) {
    throw new Error(`effort must be one of: ${EFFORT_LEVELS.join(', ')}, or empty for model default`);
  }
  const updated = [];
  for (const dir of [AGY_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = updateAgyConfigComment(before, { effort: level || 'default' });
    fs.writeFileSync(file, after, 'utf8');
    updated.push(dir);
  }
  for (const dir of [GLOBAL_OPENCODE_AGENTS_DIR, OPENCODE_AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = updateOpencodeFrontmatter(before, 'reasoningEffort', level);
    fs.writeFileSync(file, after, 'utf8');
    updated.push(dir);
  }
  return updated;
}

async function setAgentModel(id, model) {
  if (!ROSTER.some(s => s.id === id)) throw new Error(`unknown employee: ${id}`);
  const catalog = await getModelCatalog();
  if (catalog.length && !catalog.includes(model)) {
    throw new Error(`model not in current catalog: ${model}`);
  }
  const updated = [];
  let found = false;
  for (const dir of [AGY_AGENTS_DIR, GLOBAL_AGY_PLUGIN_AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    found = true;
    const before = fs.readFileSync(file, 'utf8');
    const after = updateAgyConfigComment(before, { model });
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8');
      updated.push(dir);
    }
  }
  for (const dir of [GLOBAL_OPENCODE_AGENTS_DIR, OPENCODE_AGENTS_DIR]) {
    const file = path.join(dir, id + '.md');
    if (!fs.existsSync(file)) continue;
    found = true;
    const before = fs.readFileSync(file, 'utf8');
    const after = updateOpencodeFrontmatter(before, 'model', model);
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8');
      updated.push(dir);
    }
  }
  if (!found) throw new Error(`no agent file found for ${id}`);
  return updated;
}

const PREFERRED_AGY = {
  dispatcher: 'gemini-3.8-flash-high',
  architect:  'gemini-4-argon-high',
  backend:    'gemini-3.8-flash-high',
  frontend:   'gemini-3.8-flash-high',
  qa:         'gemini-3.8-flash-high',
  reviewer:   'gemini-4-argon-high',
  reporter:   'gemini-3.8-flash-medium',
  explainer:  'gemini-3.8-flash-high',
};

const PREFERRED_OPENCODE_FREE = {
  dispatcher: 'opencode/glm-5.3-flash-free',
  architect:  'opencode/deepseek-v4.1-flash-free',
  qa:         'opencode/nemotron-3.5-super-vl-free',
  reporter:   'opencode/mimo-v2.6-flash-free',
};

async function distributeFreeModels() {
  const engine = activeEngine();
  const catalog = await getModelCatalog(engine);
  if (engine === 'agy') {
    const assignment = {};
    const updated = [];
    for (const slot of ROSTER) {
      const preferred = PREFERRED_AGY[slot.id] || 'gemini-3.8-flash-high';
      const pick = catalog.includes(preferred) ? preferred : (catalog[0] || 'gemini-3.8-flash-high');
      assignment[slot.id] = pick;
      for (const dir of await setAgentModel(slot.id, pick)) updated.push(dir);
    }
    return { assignment, spare: catalog.filter(m => !Object.values(assignment).includes(m)), totalFree: catalog.length, updated: updated.length };
  }

  const free = catalog.filter(m => /-free$/i.test(m));
  if (free.length === 0) throw new Error('the free catalog is empty right now — check `opencode models`');
  const remaining = new Set(free);
  const assignment = {};
  for (const slot of ROSTER) {
    let pick = PREFERRED_OPENCODE_FREE[slot.id];
    if (!pick || !remaining.has(pick)) pick = [...remaining][0];
    if (!pick) pick = free[0];
    remaining.delete(pick);
    assignment[slot.id] = pick;
  }
  const updated = [];
  for (const [id, model] of Object.entries(assignment)) {
    for (const dir of await setAgentModel(id, model)) updated.push(dir);
  }
  return { assignment, spare: [...remaining], totalFree: free.length, updated: updated.length };
}

function teamPayload(targetDir) {
  const activeIds = [...runs.values()].filter(r => r.status === 'running').map(r => r.agent);
  const usage = agentUsage(targetDir);
  return ROSTER.map(slot => {
    const meta = getEffectiveAgentMeta(slot.id);
    return {
      ...slot,
      mode: meta.mode || 'subagent',
      model: meta.model || 'gemini-3.8-flash-high',
      description: meta.description || slot.blurb,
      effort: meta.effort || 'default',
      usage: usage[slot.id] || { total: 0, done: 0, totalMs: 0 },
      busy: activeIds.includes(slot.id),
    };
  });
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
  fs.mkdirSync(path.join(dest, '.agents', 'agents'), { recursive: true });

  const copyIfMissing = (src, dst) => { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst); };
  copyIfMissing(path.join(TEMPLATE_DIR, '.gitignore'), path.join(dest, '.gitignore'));
  copyIfMissing(path.join(TEMPLATE_DIR, 'docs', 'report-template.md'), path.join(dest, 'docs', 'report-template.md'));

  if (fs.existsSync(AGY_AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGY_AGENTS_DIR).filter(x => x.endsWith('.md'))) {
      copyIfMissing(path.join(AGY_AGENTS_DIR, f), path.join(dest, '.agents', 'agents', f));
    }
  }

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

// ---------- git status inspection ----------
function getGitStatus(targetDir) {
  let cwd = ROOT;
  if (targetDir && typeof targetDir === 'string' && targetDir.trim()) {
    const resolved = path.resolve(targetDir.trim());
    if (path.isAbsolute(resolved) && isDir(resolved)) cwd = resolved;
  }
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain', '-b'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ dir: cwd, isRepo: false, branch: null, changedCount: 0, changedFiles: [], commits: [] });
        return;
      }
      const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
      const header = lines.shift() || '';
      let branch = 'HEAD';
      const bm = header.match(/^##\s+([^\s.]+)(?:\.\.\.([^\s\[]+))?(?:\s+\[(.+)\])?/);
      if (bm) branch = bm[1];
      else if (header.startsWith('## ')) branch = header.slice(3).trim();

      const changedFiles = lines.slice(0, 30).map(l => ({
        status: l.slice(0, 2).trim(),
        file: l.slice(3).trim(),
      }));

      execFile('git', ['-C', cwd, 'log', '-n', '5', '--oneline'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (logErr, logOut) => {
        const commits = logErr ? [] : String(logOut || '').split(/\r?\n/).filter(Boolean).map(l => {
          const sp = l.indexOf(' ');
          return sp > 0 ? { hash: l.slice(0, sp), subject: l.slice(sp + 1) } : { hash: l, subject: '' };
        });
        resolve({
          dir: cwd,
          isRepo: true,
          branch,
          clean: lines.length === 0,
          changedCount: lines.length,
          changedFiles,
          commits,
        });
      });
    });
  });
}

// ---------- run metrics (JSONL, honest history — supports project filtering) ----------
let metricsCache = { key: null, rows: null };
function appendMetric(entry) {
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n');
  } catch { /* metrics are best-effort */ }
  metricsCache = { key: null, rows: null };
}

function readMetrics(targetDir) {
  let all = [];
  try {
    const st = fs.statSync(METRICS_FILE);
    const key = st.mtimeMs + ':' + st.size;
    if (metricsCache.key === key && Array.isArray(metricsCache.rows)) {
      all = metricsCache.rows;
    } else {
      all = fs.readFileSync(METRICS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      metricsCache = { key, rows: all };
    }
  } catch {
    metricsCache = { key: null, rows: null };
    return [];
  }
  if (targetDir && typeof targetDir === 'string' && targetDir.trim()) {
    const wantKey = normalizePathKey(targetDir.trim());
    return all.filter(r => normalizePathKey(r.dir || ROOT) === wantKey);
  }
  return all;
}

function metricsSummary(targetDir) {
  const allRows = readMetrics();
  const rows = targetDir ? readMetrics(targetDir) : allRows;
  const total = rows.length;
  const done = rows.filter(r => r.status === 'done').length;
  const stopped = rows.filter(r => r.status === 'stopped').length;
  const durations = rows.map(r => r.durationMs).filter(n => typeof n === 'number' && n >= 0);
  const perAgent = {};
  for (const r of rows) {
    const a = perAgent[r.agent] = perAgent[r.agent] || { total: 0, done: 0 };
    a.total += 1;
    if (r.status === 'done') a.done += 1;
  }
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    scopedDir: targetDir ? path.resolve(targetDir) : null,
    globalTotal: allRows.length,
    total,
    done,
    stopped,
    errors: total - done - stopped,
    successRate: total ? Math.round((done / total) * 100) : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    perAgent,
    last: last ? {
      agent: last.agent, status: last.status, endedAt: last.endedAt, dir: last.dir,
      task: String(last.task || '').slice(0, 140),
    } : null,
  };
}

// ---------- reports (project-aware: mirrors dispatch/journal) ----------
function resolveReportsDir(targetDir) {
  const normalized = targetDir && typeof targetDir === 'string' ? path.resolve(targetDir) : ROOT;
  if (path.isAbsolute(normalized) && isDir(normalized)) return path.join(normalized, 'reports');
  return REPORTS;
}
function listReports(targetDir) {
  const reportsDir = resolveReportsDir(targetDir);
  if (!fs.existsSync(reportsDir)) return [];
  return fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const st = fs.statSync(path.join(reportsDir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function readReport(name, targetDir) {
  const reportsDir = resolveReportsDir(targetDir);
  const resolved = path.resolve(reportsDir, name);
  if (!resolved.startsWith(reportsDir + path.sep) || !resolved.endsWith('.md') || !fs.existsSync(resolved)) {
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
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'invalid JSON body'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- API ----
    if (pathname === '/api/team' && req.method === 'GET') {
      const engine = activeEngine();
      return sendJson(res, 200, {
        roster: teamPayload(url.searchParams.get('dir')),
        engine,
        agy: AGY_BIN,
        opencode: OPENCODE_BIN,
      });
    }
    if (pathname === '/api/git-status' && req.method === 'GET') {
      return sendJson(res, 200, await getGitStatus(url.searchParams.get('dir')));
    }
    if (pathname === '/api/reports' && req.method === 'GET') {
      return sendJson(res, 200, { dir: resolveReportsDir(url.searchParams.get('dir')), reports: listReports(url.searchParams.get('dir')) });
    }
    if (pathname.startsWith('/api/reports/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/reports/'.length));
      const md = readReport(name, url.searchParams.get('dir'));
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
    if (pathname === '/api/agents/settings' && req.method === 'GET') return sendJson(res, 200, await agentSettingsPayload());
    if (pathname === '/api/agents/settings' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const id = String(body.id || '');
        const model = String(body.model || '');
        const effort = body.effort;
        let updated = [];
        if (model) updated = updated.concat(await setAgentModel(id, model));
        if (effort !== undefined) updated = updated.concat(setAgentEffort(id, effort));
        if (!model && effort === undefined) throw new Error('nothing to change — pass model and/or effort');
        return sendJson(res, 200, { ok: true, id, updated });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---- spread the free catalog across the bench ----
    if (pathname === '/api/agents/distribute' && req.method === 'POST') {
      try {
        const result = await distributeFreeModels();
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/metrics' && req.method === 'GET') {
      return sendJson(res, 200, metricsSummary(url.searchParams.get('dir')));
    }
    if (pathname === '/api/runs' && req.method === 'GET') {
      const list = [...runs.values()]
        .map(({ child, clients, events, watchdog, journalTimer, ...r }) => ({ ...r, eventCount: events.length }))
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
      return sendJson(res, 200, { runs: list });
    }
    if (pathname === '/api/run' && req.method === 'POST') {
      const body = await readJson(req);
      const task = (body.task || '').trim();
      if (!task) return sendJson(res, 400, { error: 'task is required' });
      const requestedAgent = String(body.agent || '').trim();
      let agent = 'dispatcher';
      if (requestedAgent) {
        if (!knownAgentIds().has(requestedAgent)) return sendJson(res, 400, { error: `unknown agent: ${requestedAgent}` });
        agent = requestedAgent;
      }
      try {
        const run = startRun({ task, agent, dir: body.dir });
        return sendJson(res, 200, { id: run.id, engine: run.engine, isPhased: run.isPhased, stages: run.stages });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/run/continue' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const phaseIndex = typeof body.phaseIndex === 'number' ? body.phaseIndex : null;
        const run = startRun({ dir: body.dir, resume: true, startPhaseIndex: phaseIndex });
        return sendJson(res, 200, { id: run.id, engine: run.engine, isPhased: run.isPhased, stages: run.stages });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname.startsWith('/api/runs/') && pathname.endsWith('/pause') && req.method === 'POST') {
      const id = pathname.slice('/api/runs/'.length, -'/pause'.length);
      const run = runs.get(id);
      if (!run) return sendJson(res, 404, { error: 'unknown run' });
      if (run.status !== 'running') return sendJson(res, 409, { error: 'run already finished' });
      run.pauseRequested = true;
      pushEvent(run, {
        kind: 'raw',
        stream: 'stdout',
        text: '⏸ Pause requested — run will pause cleanly as soon as the current phase completes.',
      });
      return sendJson(res, 200, { ok: true, pauseRequested: true });
    }
    if (pathname.startsWith('/api/runs/') && pathname.endsWith('/stop') && req.method === 'POST') {
      const id = pathname.slice('/api/runs/'.length, -'/stop'.length);
      const run = runs.get(id);
      if (!run) return sendJson(res, 404, { error: 'unknown run' });
      if (run.status !== 'running') return sendJson(res, 409, { error: 'run already finished' });
      stopRun(run);
      return sendJson(res, 200, { ok: true });
    }
    // ---- project memory & phase handoff ----
    if (pathname === '/api/memory' && req.method === 'GET') {
      const dir = url.searchParams.get('dir');
      return sendJson(res, 200, {
        dir: resolveProjectDir(dir),
        memory: readProjectMemory(dir),
        cooldowns: getActiveCooldowns(),
      });
    }
    if (pathname === '/api/memory' && req.method === 'POST') {
      const body = await readJson(req);
      const dir = body.dir;
      const action = String(body.action || 'update').toLowerCase();
      if (action === 'clear') {
        clearProjectMemory(dir);
        return sendJson(res, 200, { ok: true, memory: null });
      }
      if (action === 'clear-cooldowns') {
        clearModelCooldowns();
        return sendJson(res, 200, { ok: true, cooldowns: [] });
      }
      if (action === 'init') {
        const task = String(body.task || '').trim();
        if (!task) return sendJson(res, 400, { error: 'task is required to initialize memory' });
        const mem = initProjectMemory(dir, task, body.executionMode === 'single' ? 'single' : 'phased', body.agent || 'dispatcher');
        return sendJson(res, 200, { ok: true, memory: mem });
      }
      let mem = readProjectMemory(dir);
      if (!mem) {
        if (!body.task) return sendJson(res, 404, { error: 'No project memory exists yet for this folder' });
        mem = initProjectMemory(dir, String(body.task).trim(), 'phased', 'dispatcher');
      }
      if (action === 'set-phase') {
        const idx = Number(body.phaseIndex);
        if (!Array.isArray(mem.phases) || !Number.isInteger(idx) || idx < 0 || idx >= mem.phases.length) {
          return sendJson(res, 400, { error: 'invalid phaseIndex' });
        }
        mem.currentPhaseIndex = idx;
        mem.status = 'paused';
        for (let i = idx; i < mem.phases.length; i++) {
          mem.phases[i].status = 'pending';
        }
        mem = writeProjectMemory(dir, mem);
        return sendJson(res, 200, { ok: true, memory: mem });
      }
      if (body.notes !== undefined) mem.notes = String(body.notes || '');
      if (body.planSummary !== undefined) mem.planSummary = String(body.planSummary || '');
      if (body.originalTask !== undefined && String(body.originalTask).trim()) {
        mem.originalTask = String(body.originalTask).trim();
      }
      mem = writeProjectMemory(dir, mem);
      return sendJson(res, 200, { ok: true, memory: mem });
    }
    // ---- team preferences (engine, modelRouting, inactivityTimeoutMin, phased & quota settings) ----
    if (pathname === '/api/preferences' && req.method === 'GET') return sendJson(res, 200, prefsPayload());
    if (pathname === '/api/preferences' && req.method === 'POST') {
      const body = await readJson(req);
      const current = readPrefs();
      if (body.modelRouting !== undefined) {
        const value = String(body.modelRouting || '').toLowerCase();
        if (!['static', 'dynamic'].includes(value)) return sendJson(res, 400, { error: "modelRouting must be 'static' or 'dynamic'" });
        current.modelRouting = value;
      }
      if (body.engine !== undefined) {
        const eng = String(body.engine || '').toLowerCase();
        if (!['agy', 'opencode'].includes(eng)) return sendJson(res, 400, { error: "engine must be 'agy' or 'opencode'" });
        current.engine = eng;
      }
      if (body.inactivityTimeoutMin !== undefined) {
        const t = Number(body.inactivityTimeoutMin);
        if (!Number.isFinite(t) || t < 1 || t > 120) return sendJson(res, 400, { error: 'inactivityTimeoutMin must be between 1 and 120' });
        current.inactivityTimeoutMin = Math.round(t);
      }
      if (body.executionMode !== undefined) {
        const mode = String(body.executionMode || '').toLowerCase();
        if (!['phased', 'single'].includes(mode)) return sendJson(res, 400, { error: "executionMode must be 'phased' or 'single'" });
        current.executionMode = mode;
      }
      if (body.phaseAdvance !== undefined) {
        const adv = String(body.phaseAdvance || '').toLowerCase();
        if (!['auto', 'manual'].includes(adv)) return sendJson(res, 400, { error: "phaseAdvance must be 'auto' or 'manual'" });
        current.phaseAdvance = adv;
      }
      if (body.projectMemory !== undefined) {
        current.projectMemory = Boolean(body.projectMemory);
      }
      if (body.quotaAutoSwitch !== undefined) {
        current.quotaAutoSwitch = Boolean(body.quotaAutoSwitch);
      }
      if (body.crossEngineFallback !== undefined) {
        current.crossEngineFallback = Boolean(body.crossEngineFallback);
      }
      if (body.maxQuotaRetries !== undefined) {
        const r = Number(body.maxQuotaRetries);
        if (!Number.isFinite(r) || r < 1 || r > 10) return sendJson(res, 400, { error: 'maxQuotaRetries must be between 1 and 10' });
        current.maxQuotaRetries = Math.round(r);
      }
      if (body.clearCooldowns) {
        clearModelCooldowns();
      }
      writePrefs(current);
      return sendJson(res, 200, prefsPayload());
    }

    // ---- multi-project registry & scaffolding ----
    if (pathname === '/api/projects' && req.method === 'GET') {
      const projects = readRegistry()
        .map(p => ({ ...p, exists: isDir(p.path) }))
        .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
      return sendJson(res, 200, { projects });
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = await readJson(req);
      const target = path.resolve(String(body.path || ''));
      if (!isDir(target)) return sendJson(res, 400, { error: `Not a directory: ${target}` });
      const now = new Date().toISOString();
      const name = (body.name && String(body.name).trim()) || path.basename(target);
      upsertRegistry({ name, path: target, addedAt: now, lastUsed: now });
      return sendJson(res, 200, { ok: true, path: target });
    }
    if (pathname === '/api/projects/new' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const result = scaffoldProject({ name: String(body.name || '').trim(), targetPath: String(body.path || '').trim() });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/projects' && req.method === 'DELETE') {
      const body = await readJson(req);
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
    sendJson(res, (err && err.status) || 500, { error: String(err && err.message || err) });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`AI Team HQ → http://${HOST}:${PORT}`);
    console.log(`Team root:  ${ROOT}`);
    console.log(`Engine:     ${activeEngine()} (agy: ${AGY_BIN})`);
  });
}

module.exports = {
  server,
  createLineSplitter,
  updateAgyConfigComment,
  updateOpencodeFrontmatter,
  isQuotaError,
  markModelCooldown,
  clearModelCooldowns,
  getActiveCooldowns,
  selectFallbackModel,
  buildMemoryHandoffPrompt,
  initProjectMemory,
  readProjectMemory,
  writeProjectMemory,
  clearProjectMemory,
};
