# Task Report — antigravity-upgrade

**Date:** 2026-11-12 01:14
**Task:** Migrate AI Team from OpenCode to Antigravity AI (`agy`), fix backend stream/process/metrics bugs, and upgrade the AI Team HQ dashboard UI/UX.
**Branch:** task/antigravity-upgrade
**Status:** ✅ Complete

## Executive summary
Migrated the AI Team runtime and all 13 agent definitions + 4 skills to **Google Antigravity (`agy`)** (both in workspace `.agents/` and globally in `~/.gemini/config/plugins/ai-team/`), while retaining a dual-engine toggle for OpenCode in Crew Setup. Upgraded `ui/server.js` and `ui/public/` with UTF-8 safe NDJSON line buffering, an inactivity watchdog timer, real event-driven pipeline stage tracking, project-scoped metrics, a live Git branch/working-tree inspector, rendered Markdown reports, Live Wire filters with scroll-lock, and quick-dispatch task templates. All 15 automated checks in `node tools/smoke-server.js` pass with 0 warnings.

## What was built
- **`.agents/agents/*.md` & `~/.gemini/config/plugins/ai-team/`** — 13 native Antigravity custom agents (`dispatcher`, `architect`, `backend`, `frontend`, `qa`, `reviewer`, `reporter`, `explainer`, and 5 `*-deep` specialists) and 4 skills (`task`, `report`, `frontend-design`, `web-design-guidelines`) verified via `agy agents` and `agy plugin list`.
- **`ui/server.js`** —
  - Primary **Antigravity (`agy`)** headless runner (`--print --output-format stream-json --dangerously-skip-permissions --mode auto --agent <id> --model <m> --effort <e>`) + `agy models` catalog parser.
  - `createLineSplitter()` using `StringDecoder('utf8')` so multi-chunk JSON lines never corrupt mid-buffer.
  - Real-time pipeline stage transitions (`intake → plan → build → test → review → report`) driven by subagent handoffs and `journal/*.jsonl` watcher polling.
  - Configurable inactivity watchdog timer (default 10m) that halts hung CLI runs cleanly.
  - Project-scoped `GET /api/metrics?dir=...` and new `GET /api/git-status?dir=...` endpoint.
  - Frontmatter-scoped and `<!-- ai-team-config: ... -->` writers (`updateAgyConfigComment`, `updateOpencodeFrontmatter`) that never mutate Markdown body lines.
- **`ui/public/index.html`, `ui/public/app.js`, `ui/public/style.css`** —
  - Event-driven pipeline rail replacing the fake 1.8s `setInterval` timer.
  - Auto-reattachment to active runs on page reload + **Detach** button to leave a live stream without killing the process.
  - Live Wire filter chips (`All`, `Output`, `Thoughts`, `Tools`, `Errors`) and automatic scroll-lock with `↓ Resume auto-scroll`.
  - Zero-dependency XSS-safe Markdown report renderer with `Raw MD` toggle and `Copy` button.
  - Live Git status pill & collapsible drawer showing current branch, dirty files, and recent commits, plus Project `Unregister` button and Quick-Dispatch prompt templates.
- **`AGENTS.md`, `templates/project/AGENTS.md`, `tools/new-project.ps1`, `README.md`** — Updated constitution, project scaffolder, and documentation for Antigravity (`agy`).

## How it was tested
- Runner & command: `node tools/smoke-server.js`, `node --check ui/server.js`, `node --check ui/public/app.js`, `agy agents`, `agy plugin list`.
- Result: **15 passed, 0 failed, 0 warnings** (`unit: createLineSplitter chunk & UTF-8 safety`, `unit: frontmatter & agy config comment body safety`, `GET /`, `GET /api/team`, `GET /api/metrics (project-scoped)`, `GET /api/git-status`, `GET /api/reports`, `GET /api/runs`, `POST /api/run malformed JSON`, `POST /api/run unknown agent`, `POST stop unknown run`, `POST /api/run real run + stop`, `GET /api/stream unknown run`, `GET /api/agents/settings`, `POST /api/preferences`).

## Review verdict
- Reviewer: **APPROVE**
- Findings: No unresolved CRITICAL or MAJOR issues. Frontmatter strictness in Antigravity (`agents/*.md` rejecting unknown YAML keys) was solved cleanly via `<!-- ai-team-config: ... -->` metadata comments so all 13 agents pass `agy agents` discovery while retaining per-employee model and effort settings.

## Risks & follow-ups
- If the AI Team HQ server (`node ui/server.js`) was already running before this upgrade, restart it (`Ctrl+C` and re-run `start-ui.bat` or `node ui/server.js`) so the new endpoints (`/api/git-status`, Antigravity runner) take effect.
