# G98 — contract and table reachability recheck

Fresh read-only assurance commands:

```text
npm run assurance:contracts
npm run audit:tables
```

Contract inventory exits `0`: 581 routes, 255 route-test references, 56 MCP tools, 28 MCP-test references, and 0 critical unclassified entries. Table reachability exits `0` and reports 161 schema tables, with its documented limitation that static references include tests/schema and are not runtime execution proof; the executable capability graph independently retains 165 core tables.

These counts are evidence-scope metadata, not claims that every route or table is operationally verified.
