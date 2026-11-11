---
name: task
description: Assign a task to the AI Team and run it through the full pipeline (plan -> build -> test -> review -> report). Use when the user asks to run a task with the AI Team or invokes /task.
---

# AI Team Full Pipeline Task

Take the user's requested task through the full AI Team pipeline (`plan -> build -> test -> review -> report`):

1. **Scope**: Restate the task, list acceptance criteria, and flag any ambiguities.
2. **Branch**: Create the work branch as `task/<slug>`.
3. **Plan**: Invoke `architect` (via `invoke_subagent` with `TypeName: "architect"`) for the implementation plan.
4. **Build**: Invoke `backend` and/or `frontend` (`invoke_subagent`) to implement the plan in small, clean commits.
5. **Test**: Invoke `qa` (`invoke_subagent`) to run the full test suite and add missing test coverage.
6. **Review**: Invoke `reviewer` (`invoke_subagent`) for a read-only diff review (correctness, security, performance, maintainability).
7. **Report**: Invoke `reporter` (`invoke_subagent`) to file the final report into `reports/YYYY-MM-DD-HHMM-<slug>.md` using `docs/report-template.md`.
8. **Hand back**: Do not merge — hand the branch and report back to the Principal.
