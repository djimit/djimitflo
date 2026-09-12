# G146 public explore leaderboard parity

Date: 2026-09-10

The canonical `origin/main` test gate for `GET /explore/leaderboard` was present upstream but missing from the audit checkout. The test was applied verbatim; the local file now byte-matches `origin/main` for that test.

The added route proof covers:

- feature flag off and explicit disable returning 404;
- model-only ranking sorted best-first;
- exclusion of prompts/case content from the public payload;
- malformed metadata filtering;
- single-corpus snapshot pinning;
- subset-evaluation exclusion.

Evidence:

- `node` byte comparison against `git show origin/main:packages/server/src/__tests__/explore-public.test.ts` → `exact-match`.
- `npx vitest run packages/server/src/__tests__/explore-public.test.ts --reporter=dot` → 14 tests passed.
- `npm run test --workspace=@djimitflo/server -- --reporter=dot` → 309 files passed, 2 skipped; 2465 tests passed, 20 skipped.
- `npm run assurance:contracts` → 581 routes / 265 statically exercised, 0 critical unclassified; 56 MCP tools / 28 tested.

This verifies the local public leaderboard route and upstream test parity. It does not claim that the feature flag is enabled in production or that production deployment identity is current.
