# G224 assurance recheck

Fresh local assurance after G223: `assurance:contracts` and `assurance:route-contracts` report 581 source routes with 303 contract-tested and 56/56 MCP tools tested, with zero critical unclassified entries; `assurance:integrations` passes; `audit:tables` reports 167 discovered tables and 11 statically unreachable tables. Aggregate `assurance:truth` remains fail-closed because OpenMythos evidence is blocked and live deployment identity fails. These are local contract/reachability properties, not authenticated production semantics or external-provider certification.
