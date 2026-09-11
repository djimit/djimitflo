# G243 contract, table and loop recheck

Read-only route and persistence evidence after the database-scope correction:

- `assurance:contracts`: **581 source routes, 346 direct test references, 0 critical unclassified; 56/56 MCP tools tested**.
- `assurance:route-contracts`: same route/MCP inventory and zero critical unclassified entries.
- `audit:tables -- .data/audit.sqlite`: **165 tables, 11 statically unreachable**.
- `audit:tables -- .data/djimitflo.sqlite`: **167 tables, 11 statically unreachable**.
- Canonical `/loops` self-check: **23 files passed; 291 passed; 1 skipped; 0 failures** ([loops-self-check-g243.md](loops-self-check-g243.md)).

Route inventory remains registration/auth evidence, not proof of every authorized
domain transition. Table reachability remains static SQL evidence, not
production-liveness proof. No external system or database rows were mutated.
