# AI Team — your zero-API-key AI software team (Antigravity Edition)

You give one task → a team of role-agents plans it, builds it, tests it, reviews it, and files a report. Powered primarily by **Google Antigravity (`agy` CLI + Antigravity IDE/App)** with optional **OpenCode** fallback. No API keys, no credit card.

> Honest framing first: this is not a 24/7 autonomous company. It's an on-demand, human-supervised team of specialized agents. You remain the CEO: you assign, review and merge.

---

## What's inside

```
AI team/
├── AGENTS.md                 ← the team constitution (roster, pipeline, ground rules)
├── .agents/
│   ├── agents/               ← the 8 "employees" + 5 deep-tier specialists (Antigravity format)
│   │   ├── dispatcher.md     ← primary agent: your project manager
│   │   ├── architect.md      ← subagent: planning & risk analysis
│   │   ├── backend.md        ← subagent: backend dev
│   │   ├── frontend.md       ← subagent: frontend dev
│   │   ├── qa.md             ← subagent: test engineer
│   │   ├── reviewer.md       ← subagent: read-only code reviewer
│   │   ├── reporter.md       ← subagent: writes reports/
│   │   ├── explainer.md      ← subagent: deep project read → docs/PROJECT-GUIDE.md
│   │   └── *-deep.md         ← high-reasoning specialists for dynamic routing
│   └── skills/               ← /task, /report, frontend-design, web-design-guidelines
├── .opencode/                ← synchronized OpenCode definitions for dual-engine support
├── tools/
│   ├── new-project.ps1       ← scaffold a fresh project or adopt an existing one
│   └── smoke-server.js       ← automated 15-check test suite for HQ server & adapters
├── templates/project/        ← AGENTS.md, .gitignore, docs/report-template.md, reports/
├── projects.json             ← registry of known project folders (any path)
├── ui/                       ← AI Team HQ dashboard (zero-dependency local web UI)
├── start-ui.bat              ← double-click to launch the dashboard
├── docs/report-template.md
└── reports/                  ← finished-task reports land here
```

Globally installed at `~/.gemini/config/plugins/ai-team/` so `agy` and Antigravity IDE discover the entire crew in any folder on your PC.

---

## Quick start — Antigravity CLI (`agy`)

1. Open a terminal **in any project folder**.
2. Verify the team is loaded:
   ```powershell
   agy agents
   agy models
   ```
3. Run a task with the Dispatcher:
   ```powershell
   agy --agent dispatcher "Team, add CSV export to the reports page with tests and a report"
   ```
   Or invoke a specialist directly:
   ```powershell
   agy --agent explainer "Read this project and write docs/PROJECT-GUIDE.md"
   ```

---

## Quick start — AI Team HQ dashboard (Web UI)

A local web console (`http://127.0.0.1:4357`) styled in **Claude Desktop dark** (`#141413` · `#30302e` · `#faf9f5` · `#c96442`):

1. Double-click **`start-ui.bat`** (or run `node ui\server.js`).
2. Open **http://127.0.0.1:4357**.
3. Pick a **Quick Template** (Full Feature, Architecture Plan, Run & Fix Tests, Security Review, Explain Codebase) or write your own brief, select a **Project folder**, and hit **Assign task** (`Ctrl/Cmd + Enter`).
4. Watch the **Real-Time Pipeline Rail** light up as subagents run and file shift logs, filter the **Live Wire** (`All`, `Output`, `Thoughts`, `Tools`, `Errors`), inspect **Git branch & uncommitted files** in the top bar, and read formatted **Markdown reports** on the right.

### Key Dashboard Features
- **Engine Switcher (`agy` / `opencode`)**: Defaults to Google Antigravity (`agy --print --output-format stream-json --dangerously-skip-permissions`), with one-click fallback to OpenCode in **Crew setup**.
- **Event-Driven Pipeline Rail**: Lights up `intake → plan → build → test → review → report` from actual subagent handoffs and `journal/<agent>.jsonl` updates rather than a blind timer.
- **Line-Buffered NDJSON Stream & Watchdog**: Reassembles multi-chunk UTF-8 JSON lines cleanly and automatically halts hung runs after a configurable inactivity timeout (default 10m).
- **Auto-Attach & Detach**: Automatically re-attaches to any in-flight run on browser refresh, and lets you **Detach** the viewer without killing the running process.
- **Rendered Markdown Reports**: View filed reports with rich typography, tables, and code blocks, toggle **Raw MD**, or **Copy** with one click.
- **Git Branch & Diff Inspector**: Live branch/dirty-file badge in the metrics bar with a click-to-open working tree and commit history drawer.

### Development Verification
```powershell
node tools/smoke-server.js
```
Spawns the dashboard on a scratch port (`4399`) and runs 15 unit + integration checks.
