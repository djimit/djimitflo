# Assurance recheck — G306

- governance read-route suite: 2/2 tests passed;
- `/loops`: 62 files / 612 passed / 2 skipped;
- server regression: 335 files / 2,552 passed / 20 skipped;
- workspace regression: server 2,552 + dashboard 151 + MCP 41 + catalog 26 + ransomware 40 + shared 3 + Telegram 30 = 2,843 passed / 20 skipped;
- build, type-check, lint, audit CI and assurance integrations: exit 0;
- route contracts, contracts and table reachability: exit 0; contract inventory is 585 routes / 479 direct / 106 module-covered / 0 critical unclassified and 56/56 MCP;
- assurance truth: exit 1 because live identity and OpenMythos prerequisites remain unavailable;
- `git diff --check`: exit 0.

Evidence is local authenticated HTTP/SQLite against a disposable database. No external registration, deployment, merge or protected mutation was performed.
