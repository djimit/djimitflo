# G331 compliance export route proof

Date: 2026-09-11

`packages/server/src/__tests__/governance-reports.test.ts` now exercises the canonical `/api/compliance/export` route: JSON export returns a report with content-disposition and spec totals (`200`), while an unsupported `format=xml` fails with `400 VALIDATION_ERROR`. Existing `/reports/export` CSV/type validation remains green. Focused suite passes 12/12 tests (24 assertions).

G331 contract inventory: 585 routes, 548 direct references, 0 critical unclassified, MCP 56/56. `/loops`: 62 files, 612 passed, 2 skipped, 0 failed. Server regression: 2,562 passed / 20 skipped; workspace regression: 2,853 passed / 20 skipped. This is local compliance-report generation evidence only.
