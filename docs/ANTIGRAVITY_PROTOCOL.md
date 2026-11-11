# Antigravity Task Protocol

## Channel
Claude writes task specs to `implementation/tasks/TASK-XXX.md`. Owner hands the file to Antigravity (no direct agent-to-agent link). Antigravity works on branch `task/TASK-XXX`, opens a PR, and writes `reports/TASK-XXX-report.md`. Claude reviews the PR diff + report.

## Task spec template
```
# TASK-XXX — <title>
OBJECTIVE:
BACKGROUND: (only essential context, links to docs)
SCOPE: (exact files/modules)
OUT OF SCOPE:
TECHNICAL INSTRUCTIONS:
ACCEPTANCE CRITERIA: (measurable)
TEST REQUIREMENTS: (commands to run)
DELIVERABLES:
```

## Report template (Antigravity must fill all fields)
```
# TASK-XXX report
Implemented:
Files created/modified/deleted:
Technical decisions made:
Tests executed (exact commands):
Actual results (paste output summary):
Known limitations:
Deviations from spec (and why):
Remaining risks:
```

## Hard rules for Antigravity
No changes outside SCOPE · no new dependencies · no schema changes unless in SCOPE · no deleting tests/functionality to pass tests · no deploys/production config · never mark work accepted · if blocked or a better design is found: stop, report, wait.

## Claude review outcomes
ACCEPTED · ACCEPTED WITH DOCUMENTED LIMITATIONS · REJECTED — CORRECTIONS REQUIRED · BLOCKED — OWNER DECISION REQUIRED.
Review covers diff, architecture fit, error handling, security, data integrity, compatibility, test quality, regressions. Passing tests alone is not acceptance.
