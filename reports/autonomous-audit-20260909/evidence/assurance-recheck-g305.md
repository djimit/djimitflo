# Assurance recheck — G305

- federation route suites: 3/3 files and 4/4 tests passed;
- build, type-check, lint and audit CI: exit 0;
- assurance integrations, route-contracts, contracts and table reachability: exit 0; contract inventory is 585 routes / 475 direct / 110 module-covered / 0 unclassified and 56/56 MCP;
- assurance truth: exit 1 because live identity and OpenMythos prerequisites remain unavailable;
- server regression: 335 files / 2,551 passed / 20 skipped;
- workspace regression: 335 files / 2,551 passed / 20 skipped, plus dashboard 151, MCP 41, catalog 26, ransomware 40, shared 3 and Telegram 30 = 2,842 passed / 20 skipped;
- governed `/loops`: 62 files / 612 passed / 2 skipped;
- `git diff --check`: exit 0.

Federation evidence is local authenticated HTTP/SQLite with a disposable peer fixture. No external peer registration, cross-node delivery, deployment, merge or external mutation was performed.
