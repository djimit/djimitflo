# G145 dependency audit and lockfile hygiene

Date: 2026-09-10

The production dependency graph was re-audited after the security scan surfaced two moderate development/dependency findings:

- `hono` was upgraded in the lockfile from `4.13.3` to `4.13.7` (the transitive MCP transport dependency).
- Root `vitest` was moved from `dependencies` to `devDependencies`; the test runner is not part of the production runtime.

Executed evidence:

- `npm explain hono` → Hono is only reached through `@modelcontextprotocol/sdk` in `@djimitflo/mcp-server`; `npm explain vitest` → all workspace/root references are dev-only.
- `npm audit --omit=dev --audit-level=moderate` → `found 0 vulnerabilities`.
- `npm run audit:ci` → pass; no unaccepted high/critical production advisories.
- `npm ci --dry-run --ignore-scripts --no-audit` → exit 0.
- `npm run build` → exit 0.
- `npm run type-check && npm run lint` → exit 0.
- `npm test -- --reporter=dot` → 309 server test files passed, 2 skipped; 2459 server tests passed, 20 skipped; all workspace suites passed (catalog 26, dashboard 151, MCP 39, ransomware 40, shared 3, Telegram 30).
- `/loops` regression (`npx vitest run packages/server/src/__tests__/*loop*.test.ts --reporter=dot`) → 41 files, 534 passed, 2 skipped.

The full development audit can still report the pinned root Vitest 4.1.10 advisory because the lockfile keeps that root tool version for reproducibility; this is explicitly dev-only and excluded from the production audit. No production dependency vulnerability is claimed beyond the `--omit=dev` result. No deployment or external mutation was performed.
