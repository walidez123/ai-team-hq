---
name: report
description: File the formal stakeholder report into reports/ for completed AI Team work using docs/report-template.md. Use when the user asks to generate or file a task report.
---

# File AI Team Task Report

File the final report for the task that was just completed:

1. Gather evidence strictly from what happened (`git log --oneline`, `git diff`, QA test output, and reviewer verdict). Never invent results.
2. Read `docs/report-template.md` and save the completed report into `reports/YYYY-MM-DD-HHMM-<slug>.md`.
3. Include QA pass/fail counts and the Reviewer verdict (`APPROVE`, `APPROVE WITH COMMENTS`, or `REQUEST CHANGES`) verbatim.
4. Append a shift log entry to `journal/reporter.jsonl`.
