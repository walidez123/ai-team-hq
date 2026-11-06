# AI Team — your zero-API-key AI software team

You give one task → a team of role-agents plans it, builds it, tests it, reviews it, and files a report. Built to run on **free tiers only** (OpenCode free models + Antigravity Individual $0 plan). No API keys, no credit card.

> Honest framing first: this is not a 24/7 autonomous company. It's an on-demand, human-supervised team of specialized agents. You remain the CEO: you assign, review and merge.

---

## What's inside

```
AI team/
├── AGENTS.md              ← the team constitution (roster, pipeline, ground rules)
├── opencode.json          ← default free model + project config for OpenCode
├── .opencode/
│   ├── agents/            ← the 7 "employees" (markdown role definitions)
│   │   ├── dispatcher.md  ← primary agent (Tab to it): your project manager
│   │   ├── architect.md   ← subagent: planning
│   │   ├── backend.md     ← subagent: backend dev
│   │   ├── frontend.md    ← subagent: frontend dev
│   │   ├── qa.md          ← subagent: test engineer
│   │   ├── reviewer.md    ← subagent: read-only code reviewer
│   │   ├── reporter.md    ← subagent: writes reports/
│   │   └── explainer.md   ← subagent: deep project read → docs/PROJECT-GUIDE.md
│   └── commands/          ← /task and /report shortcuts
├── tools/new-project.ps1     ← scaffold a fresh project or adopt an existing one
├── templates/project/        ← AGENTS.md, .gitignore, docs/report-template.md, reports/
├── projects.json             ← registry of known project folders (any path)
├── ui/                  ← AI Team HQ dashboard (zero-dependency local web UI)
├── start-ui.bat         ← double-click to launch the dashboard
├── docs/report-template.md
└── reports/             ← finished-task reports land here
```

OpenCode reads `AGENTS.md` automatically as project rules.

---

## Credits

- `.opencode/skills/frontend-design/` — design guidance from [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) (installed 2026-11-05, upstream license applies). It's how the dashboard got its "dispatch room" look, and your OpenCode agents can load it too.
- `.opencode/skills/web-design-guidelines/` — Vercel's [Web Interface Guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) audit skill (installed 2026-11-06, canonical rules: [web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines)). Used to audit and fix accessibility, forms, focus states and touch behavior. Offline snapshot of the rules kept as `command.md`.

---

## Quick start — OpenCode (terminal)

1. Open a terminal **in the project you want built** (not this folder — see "Two ways to use"). To use the team everywhere, copy or symlink `.opencode/agents` and `.opencode/commands` into your global config folder (`~/.config/opencode/`).
2. Run `opencode`.
3. Press `Tab` until you land on **dispatcher**.
4. Give it work:

   ```
   /task add CSV export to the reports page
   ```

   or just talk: *"Team, add CSV export. Backend endpoint + frontend button + tests + report."*

5. The dispatcher routes the work: `@architect` → `@backend` / `@frontend` → `@qa` → `@reviewer` → `@reporter`. You can also call any employee directly, e.g. `@qa re-run the suite and fix what fails`.
6. Review the diff, approve the merge. The report is in `reports/`.

Useful commands:

```
opencode models          # list models — find today's current free ones (they rotate!)
opencode debug agents    # confirm the 7 agents loaded
```

## Quick start — AI Team HQ dashboard (simple UI)

A small local web UI for the team: roster with live status, a task box that dispatches into OpenCode and streams the run, and a reports viewer. **Zero dependencies** (pure Node + vanilla JS), binds to `127.0.0.1` only. Styled as **Claude Desktop dark** — warm near-black surfaces, ivory text, terracotta CTAs, Newsreader serif accents (palette grounded in Claude's published design system: `#141413` · `#30302e` · `#faf9f5` · `#c96442`), with an in-app **field guide** and per-control tooltips.

1. Double-click **`start-ui.bat`** (or run `node ui\server.js`).
2. Open **http://127.0.0.1:4357** (the .bat opens it for you).
2b. **First visit opens the field guide** — an overlay explaining every element, with hints throughout (hover any control; press `?` to reopen, `/` to jump to the task field, `Ctrl/Cmd+Enter` to assign). Dismissed once, remembered in `localStorage`.
3. Type a task, pick an employee (or keep `dispatcher` for the full pipeline), optionally set a **Project folder** (any git repo on disk; default = this HQ folder), hit **Assign task**.
4. Watch the live stream in the Console panel. Hit **■ stop** anytime. Finished reports appear in the right panel.

Notes:

- **Run metrics:** every run is journaled to `reports/.metrics.jsonl` (task, agent, project, start/end, duration, exit code) and summarized live in the console strip under the rail: totals, % green, average duration, last result. Honest data — the one row from 2026-11-06 records a free-tier timeout I had to kill (see chat log). Add `reports/.metrics.jsonl` to gitignores (the project template already does).
- Runs use `opencode run --auto` (auto-approves permissions so OpenCode doesn't stall waiting for a human) — watch the console stream and **stop** anything you don't like.
- Concurrency: each task = one `opencode` process; agents inside one run still execute sequentially.
- Change port with `set PORT=xxxx && node ui\server.js`.
- It is a local console, not a hosted service — don't expose it to the network.

## Quick start — Antigravity (desktop app)

Antigravity is Google's agent-first IDE/app. The **Agent Manager** is the closest thing to a "team of employees" UI: you spawn agents in parallel, each in its own workspace, and they post artifacts (plans, diffs, screenshots, browser recordings).

1. Download Antigravity, sign in with a personal Google account → **Individual plan, $0/month** (unlimited tab completions/command requests, agent quota refreshes **weekly**; work-based, complex tasks eat more quota).
2. Agent Manager → **New Agent** in your project workspace.
3. Give the agent its role by pasting the body (prompt) of a file from `.opencode/agents/` (everything below the `---` frontmatter) plus "Read AGENTS.md first."
4. Spawn several agents — one per panel/workspace — e.g. Architect in workspace A, Backend in B, QA in C. Keep writes on separate branches/workspaces to avoid collisions.
5. Use the **built-in browser** + **artifacts** as your QA evidence: ask the QA agent to verify the UI and attach screenshots; artifacts become your report.
6. Antigravity has **scheduled tasks** — e.g. a nightly "audit deps + summarize" cron job.

> Note: as of Nov 18, 2026, the free/base Antigravity plans only carry Gemini models; the Claude 4.6 / GPT-OSS models leave free tiers that day.

---

## Free-tier reality check (read this)

| Service | Cost | What you get | The catch |
|---|---|---|---|
| OpenCode free models (`opencode/*-free`) | $0, no signup/key, in-app only | e.g. `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `nemotron-3.5-super-vl-free`, `big-pickle`, … | List rotates, no published rate limit, usage may train models, can feel degraded at peak times. Check `opencode models` regularly. |
| OpenCode CLI itself | Free & open source | Everything above | — |
| Antigravity Individual | $0/month | Gemini models, Agent Manager, artifacts, browser, CLI, scheduled tasks | Quota is **work-based** with a **weekly** refresh; heavy parallel runs exhaust it. Pro is $19.99/mo if you outgrow it. |

Practical budget tips:

- Use the free/flash models for bulk work; save your (also free) allowance's best model for architecture and review passes.
- One task at a time in OpenCode; parallel fan-out is Antigravity's job (mind the weekly quota).
- If you ever see `FreeUsageLimitError`, you waited for the refresh or switch models — it's not your code.

## What this team cannot do (yet)

- It is **not** an autonomous company. Agents are only as good as the model and your supervision.
- Free models are strong but weaker than paid frontier models at long-horizon tasks — expect more review loops.
- Two agents editing the same files will corrupt them — always branch per task / per agent.
- No API keys also means **no third-party integrations** (email, Jira, Slack) from the team itself. Use Antigravity scheduled tasks or opencode plugins if you need those later.

## Where projects live (any path on the PC)

The team is **not tied to this folder**. Agents, commands and the frontend-design skill are installed globally in `C:\Users\waled\.config\opencode\` (agents, commands, skills), so `dispatcher`, `@qa` and `/task` work in **any directory** on this PC.

Each project gets its own folder **wherever you want it** (e.g. `C:\work\invoice-cli`, `D:\repos\site`) — the HQ only tracks them in `projects.json`:

- **New project:** HQ → *New project…* (or `.\tools\new-project.ps1 -Name foo -Path "C:\work\foo"`) → creates the folder, `git init`, `AGENTS.md`, `docs\report-template.md`, `reports\`, and registers it.
- **Existing project (add features):** same command with `-Adopt`, or *New project…* with a non-empty path — only missing files are added, **nothing is overwritten**.
- **Register any folder:** type the path in the HQ, click *Register folder* → it shows up in the *known projects* dropdown forever after.
- Reports are filed inside each project's own `reports\` folder by `@reporter`.

Config the team reads per project: the project's own `AGENTS.md` (created from `templates\project\AGENTS.md`).

## Two ways to use this folder

- **Option A (recommended):** treat this as your team *HQ* + template. When starting real software, create the project folder, then copy `AGENTS.md`, `.opencode/`, `docs/` and `reports/` into it.
- **Option B:** `git init` here and build small apps directly inside `projects/` subfolders.

OpenCode agents only load from the current project (or global `~/.config/opencode/agents/`), so copy them (or symlink `C:\Users\waled\OneDrive\Desktop\AI team\.opencode` into projects) as needed.

## Suggested first mission

```
/task create a tiny Node CLI in projects/hello-team/ that reads a CSV of tasks and prints a daily standup summary, with tests, and a report.
```

You'll see the full pipeline (dispatch → plan → build → test → review → report) working end-to-end with zero spend.
