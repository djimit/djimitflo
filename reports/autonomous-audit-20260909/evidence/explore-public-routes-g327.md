# G327 public Explore route proof

Date: 2026-09-11

`packages/server/src/__tests__/explore-public.test.ts` executes the public `/explore` router against local SQLite:

- `GET /explore/sitemap.xml` and `GET /explore/robots.txt` return crawler metadata (`200`).
- `GET /explore/leaderboard` remains explicitly unpublished by default (`404`).
- Missing repository `llms.txt` and `badge.svg` return typed public `404` responses.
- The existing published fixture proves `GET /explore/:owner/:repo/llms.txt` and `/opengraph.svg` return actual content (`200`).

Focused Explore suite: 15/15 passed. G327 contract inventory: 585 routes, 540 direct references, 0 critical unclassified, MCP 56/56. `/loops`: 62 files, 612 passed, 2 skipped, 0 failed. The first full server run timed out only in the existing e2e smoke after 180s; immediate rerun passed 336 files / 2,562 tests / 20 skips. Workspace regression passed 2,853 / 20 skips. This is local/public fixture evidence, not production deployment certification.
