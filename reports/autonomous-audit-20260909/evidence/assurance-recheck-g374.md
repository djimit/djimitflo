# G374 — Assurance recheck

The post-G370 assurance checks pass for local/static scopes:

- `assurance:contracts`: 585 source routes, 564 direct references, 0 critical unclassified, MCP 56/56.
- `assurance:route-contracts`: pass with the same contract counts.
- `assurance:integrations`: pass.
- `audit:ci`: pass; no unaccepted high/critical production advisories.
- `audit:tables`: pass; 167 tables, 160 empty, 10 statically unreachable classifications.
- `build`, `type-check`, `lint`: pass.

`assurance:truth` and `assurance:live` remain fail-closed because production identity, browser session and OpenMythos certification evidence are unavailable. No promotion, merge or deployment is claimed.
