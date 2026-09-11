# Assurance recheck — G295

- build, type-check and lint: exit 0;
- audit CI: exit 0; no unaccepted high/critical production advisories;
- assurance integrations/contracts: exit 0;
- assurance truth: exit 1 because live identity and OpenMythos prerequisites remain unavailable; this is retained as an external certification gate;
- `git diff --check`: exit 0.

The new authority/risk/canvas route proof and G294 self-hosted Astra evidence remain local, disposable evidence. No deployment, merge or external mutation was performed.
