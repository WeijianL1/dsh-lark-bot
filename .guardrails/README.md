# Fork checks

This fork uses pre-commit, Gitleaks, actionlint, and zizmor. Versions and checksums
are pinned in sources.json; Python tool versions are in requirements.txt.

Install the tools with `python3 .guardrails/install_tools.py` and an isolated
Python environment containing `.guardrails/requirements.txt`. Then run
`pre-commit install` and configure `.git/hooks/pre-push` to run
`python3 .guardrails/checks.py pre-push` from the repository root, forwarding stdin.
The pre-push hook rejects direct pushes to main/master/production, tags, deletion,
non-fast-forward updates, and unvalidated revisions. It checks new history and
runs the upstream quality command. `baseline-ref` records the upstream starting
commit; inherited historical findings are outside this initial change.

The Fork Guardrails workflow repeats changed-file and commit-history checks,
then runs the full upstream quality command. GitHub rulesets require both
`Fork guardrails` and `Fork quality` from GitHub Actions. No bypass actors are
configured. A zero required approval count supports solo maintenance; a code
review is still part of the agent workflow. CI does not publish or deploy.

Local Git hooks do not execute for GitHub API writes. The local Codex routing
hook sends managed-fork code writes through Git; GitHub rulesets enforce merging.
Secrets must be checked BEFORE upload: failing CI cannot undo disclosure.

Use Node.js 24.20.0 (npm 11) for local quality checks, matching CI. npm 10
can run prepare during pack --ignore-scripts and corrupt JSON output.

PR scans use the PR base commit. Push scans use the recorded fork baseline,
so squashing a branch does not depend on an unreachable previous tip. Push
scans require the baseline to be an ancestor. PR scans also support diverged
target branches. Both paths scan all new history.
