# G256 route registration and contract recheck

`npm run assurance:route-contracts` passes with the same 581/350/0 route-contract counts and 56/56 MCP coverage. The instantiated runtime registration check passes with 614 registrations and 608 anonymous auth probes; semantic execution remains explicitly `NOT_EXECUTED` in that check.
