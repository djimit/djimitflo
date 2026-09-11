# G96 — external assurance prerequisite recheck

Fresh commands:

```text
npm run assurance:openmythos
npm run assurance:live
```

OpenMythos structural validation passes all 351 cases and the 18 draft lifecycle oracle cases, but admissibility remains `blocked`: only 7/351 cases are validated and repeatability plus held-out discrimination are `not_run`.

Live identity remains `fail`: the local probe at `http://127.0.0.1:3001` cannot fetch health, version or authenticated provenance; database integrity is readable, but intended revision is dirty and deployment identity is not verified.

These are current external prerequisites, not code-test failures. No deployment, data mutation or promotion was attempted.
