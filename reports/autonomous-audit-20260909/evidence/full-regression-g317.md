# G317 full regression

- Server workspace: 335 files, 2,556 passed, 20 skipped, 0 failed.
- Full workspace: 377 files, 2,847 passed, 20 skipped, 0 failed (server 2,556; dashboard 151; MCP 41; catalog 26; ransomware 40; shared 3; Telegram 30).
- Build, type-check and lint: pass.
- `/loops` G316: 62 files, 612 passed, 2 skipped, 0 failed.
- Contract inventory G316: 585 routes, 495 direct, 0 critical unclassified; 56/56 MCP tools.

The first broad command that included `.stryker-tmp` was discarded because it duplicated sandbox tests and produced environment-dependent failures. The authoritative workspace scripts were rerun through npm workspaces and completed green; no product failure is inferred from the discarded run.
