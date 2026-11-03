# Evidence

The raw evidence files (889 probe outputs, screenshots and JSON dumps, 80 MB) behind these reports were removed from
the working tree on 2026-09-25 to keep the repository lean. They remain in git history:

    git show <commit-before-removal>:reports/autonomous-audit-20260909/evidence/<file>
    git log --diff-filter=D --name-only -- reports/autonomous-audit-20260909/evidence | head

The reports in this folder describe the state of 2026-09-09. For the current state see the
[self-improvement runbook](../../docs/runbooks/self-improvement-loop-operations.md) and the ADRs in `docs/adr/`.
