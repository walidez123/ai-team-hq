# Research Report — How Anthropic uses AI for development vs. how we do it

**Date:** 2026-11-06
**Task:** how Anthropic uses AI internally for development, measured against our AI Team (dispatch room), what differs, and whether the Anthropic way is doable here.
**Method:** primary sources only — Anthropic engineering blog, research publications and product docs (URLs in Sources, accessed 2026-11-06).

## Executive summary

Anthropic dogfoods itself as its own most demanding customer. Their method is not a secret pipeline — it is a set of habits: **CLAUDE.md rules in every repo, Claude Code as the “first stop” for every engineering task, aggressive delegation of verifiable work, test automation in CI, orchestrator–worker multi-agent architectures with isolated contexts, and eval-driven prompt iteration — all wrapped in constant human supervision.**
Our AI Team independently implements the same skeleton: rules files, role-agents, a dispatch pipeline with a QA gate and a human merge gate. The differences are not philosophical — they are **scale, model quality, eval infrastructure, and CI automation**. Those gaps are closable in stages for ~$0, except the frontier-model gap, which is buyable later, not free now.

## How Anthropic actually does it

**1. Claude Code as the universal first stop.** Anthropic reports engineers using Claude for debugging (55% daily), code understanding (42%), and feature building (37%). Roughly 59% of their work involves Claude (was 28% a year ago), with a self-reported +50% productivity boost (was +20%). [research/how-ai-is-transforming-work-at-anthropic, Dec 2025]

**2. Rules files everywhere.** Every codebase carries `CLAUDE.md` — kept fresh, committed to git, tuned with "IMPORTANT" emphasis, occasionally run through Anthropic's prompt improver. It is how new engineers (and Claude) onboard: feed the codebase, read its CLAUDE.md files, map dependencies. [news/how-anthropic-teams-use-claude-code; research/claude-code-best-practices, Apr 2025]

**3. Delegation is deliberate, not wholesale.** Engineers fully delegate only ~0–20% of work; they delegate tasks that are *verifiable, low-stakes, boring, self-contained* — and keep taste/design/high-stakes judgment. The most-delegated categories: implementation, debugging, tests, documentation, "papercut" chores (8.6% of tasks are papercut fixes). [research/how-ai-is-transforming-work-at-anthropic]

**4. Multi-agent orchestrator–worker architectures.** Their Research system uses a lead agent that decomposes work and delegates to parallel subagents, each with its **own context window**. Token usage explains 80% of performance variance; agents use ~4× the tokens of chat, multi-agent ~15× — so multi-agent only pays on *high-value, parallelizable, long-horizon* tasks. Prompts are built by iteration and **evaluated** ("Effective evaluation of agents" is a core chapter of their multi-agent write-up). [engineering/multi-agent-research-system, Jun 2025]

**5. Test and review automation in CI.** Teams auto-generate tests, and run Claude in GitHub Actions to handle PR comments, formatting fixes and test refactoring. The Security team reorganized work into TDD with Claude as pseudocode-guide. [news/how-anthropic-teams-use-claude-code]

**6. Agents for paperwork and onboarding.** Claude reads codebases to produce onboarding explanation, runbooks, and dependency maps — replacing wiki/docs gaps. [news/how-anthropic-teams-use-claude-code]

**7. Humans review; autonomy grows with trust.** Output is verified; design/taste/strategy stays human. Reported autonomy edge: ~21 tool-chained actions per transcript (was ~10), human turns per transcript down 33% — delegation deepens as models prove out. [research/how-ai-is-transforming-work-at-anthropic]

## What we built (for comparison)

8 role-agents in OpenCode on free models (`dispatcher → architect → backend/frontend → qa → reviewer → reporter`, plus `explainer` for codebase read-out) · `AGENTS.md` constitution (project + global crew card in `~/.config/opencode/AGENTS.md`) · one task = one branch = one report · human gate at merge · Antigravity for parallel agents · HQ dashboard (dispatch, live stream, filed reports) · free-tier models with no API keys · skills: `frontend-design`, `web-design-guidelines`.

## Difference, side by side

| Dimension | Anthropic | Our AI Team | Verdict |
|---|---|---|---|
| Rules file | `CLAUDE.md` per repo, committed, tuned | `AGENTS.md` per project + global crew card | Same pattern, slightly less tuning rigor |
| Orchestration | Orchestrator–worker, parallel subagents, isolated contexts, token-budget-aware | Sequential pipeline in one shared session; parallel via Antigravity Manager | Good bones; **parallel isolation missing** in OpenCode path |
| Agent roles | Implicit (Claude Code + subagents/skills) | Explicit 8 specialists with permissions & prompts | We are *more* prescriptive |
| Model tier | Opus-class frontier | Free flash-class (rotating, unrated, rate-limited) | This is the quality gap |
| Evals | First-class: iterate prompts/architectures against evals; eval-driven fixes | **None** — ad-hoc “it looks right” | **Biggest methodology gap** |
| CI automation | GitHub Actions running Claude on PRs/tests | None | Cheap to add, high value |
| Test discipline | TDD + automated test authoring | QA agent runs/writes tests in-pipeline | Same discipline, lower model horsepower |
| Onboarding/docs | Claude-driven codebase read-out, runbooks | `@explainer` → `docs/PROJECT-GUIDE.md` | Directly analogous |
| Human oversight | 0–20% fully delegated; verify everything | Human owns merge button; dispatcher can't merge | Same philosophy, enforced culturally not technically |
| Observability | Internal usage analytics (200k transcripts analyzed) | Zero telemetry; in-memory run log only | They measure; we don't |
| Cost model | Pay frontier prices, amortized by value | $0, but weaker + rate-limited | You get what you can't pay for |
| Learning loop | Prompt improver + evals + telemetry | None formal | Cheapest upgrade available |

## Is the Anthropic way doable for us?

**Already done (free, by design):**
- Rules-as-context (`AGENTS.md` everywhere) · role specialization · dispatch→build→test→review→report pipeline · human merge gate · codebase explainer · parallel agents via Antigravity · skills library.

**Doable now ($0, weeks not months):**
1. **Guardrail evals** — 10–15 canonical tasks (add endpoint; fix bug; write tests; doc update) with known-good outputs; run monthly across model rotations; track pass rate. This is the single highest-leverage move. (Weekend of work.)
2. **Prompt tuning pass** — run our 8 prompts through the same “IMPORTANT”-emphasis/emphasis tuning discipline Anthropic describes; tighten dispatcher's delegation criteria (verifiable, self-contained, low-stakes).
3. **CI automation** — a GitHub Actions job that runs `opencode run` (or Claude Code if they later pay) to comment on PRs and fix format/test failures — mirroring their Actions pattern. Needs only `gh` + one workflow file.
4. **TDD prompt hardening** — Security-team lesson: make `qa` agent start from failing tests when feasible, not just after implementation.
5. **Measurement** — log every run (already in-memory); persist to `reports/.metrics.jsonl`: task, agent, outcome, wall time, exit code → weekly digest. Cheap, closes the “we fly blind” gap.

**Needs money or scale (not free, but possible):**
- Frontier-model access (Claude/GPT top tier): closes the quality gap directly; roughly the single largest lever.
- True parallel orchestrator–worker at scale with isolated contexts + token budgeting (Antigravity is the pragmatic approximation on free tier).
- Dedicated eval suites (100s of scenarios), observability, regression tracking — the “software factory” grade.

**Not doable (nor desirable):**
- 15× token budgets on free quota; 200k-transcript internal analytics; training-culture changes. Overkill for one-person operation.

## Recommendations (ranked)

1. Build the **12-task eval suite** — one evening.
2. **Persist run metrics** in the HQ (extend `/api/runs` to append JSONL) — one hour.
3. **GitHub Actions PR-reviewer** using free-tier OpenCode — one afternoon + one PAT.
4. **Prompt-tune the 8 agents** with eval feedback; add “IMPORTANT” emphasis sparingly.
5. When quarterly review hits, **buy one month of a frontier plan** (e.g. Antigravity Pro or Claude Code subscription) — compare eval pass rate vs free tier; let data decide.
6. Keep the human-merge rule sacred — it is the one thing Anthropic's own data says never to remove.

## Honest gaps in this report

Anthropic publishes results, not full transcripts; internal tooling (eval harnesses, prompt improver internals, exact budgets) is not public. Numbers above are as-published (self-reported survey/usage data, 132 respondents; marketing-adjacent sources). Our own “8 agents work” conclusion rests on demonstration runs, not evals — finding #1 below is load-bearing.

## Sources

- How AI is transforming work at Anthropic — anthropic.com/research/how-ai-is-transforming-work-at-anthropic (Dec 2025)
- How Anthropic teams use Claude Code — anthropic.com/news/how-anthropic-teams-use-claude-code (Jun 2025 / updated Jul 2025)
- Claude Code best practices — anthropic.com/research/claude-code-best-practices (Apr 2025)
- How we built our multi-agent research system — anthropic.com/engineering/multi-agent-research-system (Jun 2025)
- HN/Community signal: METR experienced-dev study — metr.org (Jul 2025)

## Verdict

We are not a toy version of what Anthropic does — we are **the same architecture with commodity parts**. Rules files, role agents, orchestrator dispatch, TDD-ish gates, human oversight: all present. Missing: evals, CI automation, frontier horsepower, measurement. Items 1–4 cost evenings, not money. The gap that remains after that is bought, not built.
