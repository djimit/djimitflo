# G247 KnowledgeBus cleanup

Removed the unused `wireKnowledgeBusToDB` no-op seam and its placeholder
documentation. Claim publication already occurs at the authoritative
`SwarmIntelligenceService.createClaim` boundary; the authenticated HTTP
publish/subscribe transport remains intact.

Validation:

- focused KnowledgeBus and swarm-intelligence route tests: **8 passed / 0 failed**
- server type-check: pass
- server lint: pass
- governed `/loops`: **23 files, 291 passed, 1 skipped, 0 failed**

No database schema or external integration was changed.
