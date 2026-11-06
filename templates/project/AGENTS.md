# {{NAME}} — Project Rules (AI Team)

This project is worked by the **AI Team** (installed globally in `C:\Users\waled\.config\opencode\`). The human owner is the "Principal" and merges all work.

## Crew

| Role       | Agent        | Owns                                              |
|------------|--------------|---------------------------------------------------|
| Dispatcher | `dispatcher` | Scopes a task and routes it through the pipeline   |
| Architect  | `architect`  | Plan: files to touch, risks, test strategy         |
| Backend    | `backend`    | Server-side code, APIs, data layer                 |
| Frontend   | `frontend`   | UI, styling, client behavior, accessibility        |
| QA         | `qa`         | Test suite runs, new tests, bug reports            |
| Reviewer   | `reviewer`   | Read-only diff review: bugs, security, performance |
| Reporter   | `reporter`   | Final report → `reports/`                          |
| Explainer  | `explainer`  | Deep project read → `docs/PROJECT-GUIDE.md`        |

## Pipeline (every task)

Scope → `@architect` plan → `@backend` / `@frontend` implement → `@qa` test → `@reviewer` review → `@reporter` files `reports/YYYY-MM-DD-HHMM-<slug>.md`.

## Definition of done

- Builds and lint/typecheck pass
- Full test suite green
- New code covered by tests
- No unresolved CRITICAL/MAJOR review findings
- Report filed in `reports/`

## Ground rules

- One task = one branch (`task/<slug>`) = one report.
- Small commits, conventional messages. Never force-push. No merges without the Principal.
- No secrets in code or commits. Free models may train on inputs — nothing confidential belongs here.
- If blocked (quota, failing build, unclear spec), stop and say so.
