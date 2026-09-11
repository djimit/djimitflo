# G97 — live production differential recheck

Read-only probes against `https://djimitflo.agentical.nl/`:

- `/`: HTTP 200, 550 bytes; current assets include `index-4v75G2Yu.js` and `PipelineBuilderPage-BEjru09w.js`.
- `/api/version`: HTTP 200, `{"version":"0.5.8","name":"Djimitflo API"}`.
- The deployed Pipeline Builder chunk still contains `onClick:()=>alert("Pipeline saved!")`.

The local implementation and tests persist/validate/restore drafts, but that correction is not deployed. No authenticated browser session or production mutation was attempted.
