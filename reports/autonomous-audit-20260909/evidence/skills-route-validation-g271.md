# G271 skills route semantic validation

`route-permissions-http.test.ts` now exercises the admitted-skill read chain
over real Express/supertest and SQLite: list, statistics, detail, missing
resource, agent assignment projection, trigger lookup and anonymous denial.
The rejected prompt-injection fixture is absent from the admitted list, and
the assignment projection starts empty before the separate write-boundary
test. The focused file passes 13/13 tests (the Vitest command reports two test
files because of the configured workspace include pattern).

Contract assurance increased from 358 to 363 directly exercised routes while
remaining at 585 total, zero critical unclassified and 56/56 MCP tools.
Registration/auth recheck remains 619/610 with semantic execution separate.
