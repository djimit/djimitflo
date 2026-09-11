# G189 full server regression and auth-probe recheck

Date: 2026-09-10

- Full `@djimitflo/server` suite: 311 files (2 skipped), 2481 passed, 20 skipped, 0 failed.
- Route inventory: 614 registered routes, 608/608 anonymous auth denials, 581 source declarations, 286 contract-tested routes.
- The first full-suite run observed one transient 200 for `GET /api/segml/l5/status`; isolated inventory and the repeated full suite both passed. The observation remains intermittent UNKNOWN, not an auth-bypass claim.
- Build, type-check, lint, `/loops` (23 files, 291 passed, 1 skipped), and configured mutation testing remain green.
