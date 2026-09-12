# G221 assurance and reachability recheck

Fresh read-only assurance checks after G220 pass locally: `assurance:contracts` and `assurance:route-contracts` report 581 source routes with 300 contract-tested and 56/56 MCP tools tested, with zero critical unclassified entries; `assurance:integrations` passes its integration probes; `audit:tables` reports 167 discovered tables and 11 statically unreachable tables. These are local contract/reachability properties, not authenticated production semantics or external-provider certification.
