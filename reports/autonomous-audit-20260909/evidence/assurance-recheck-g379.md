# G379 — current assurance truth rerun

After the Qdrant timeout reconciliation and final route tests:

- `npm run assurance:truth` → fail-closed (`openmythos_evidence` blocked and `live_identity` failed; local contracts/integrations/dependency checks pass).
- `npm run assurance:live` → fail (`http://127.0.0.1:3001` was not reachable for authenticated provenance; database integrity itself passed).

This is a current negative result, not a product regression. No credentials were guessed, no external authority was bypassed, and no promotion/deployment was attempted.
