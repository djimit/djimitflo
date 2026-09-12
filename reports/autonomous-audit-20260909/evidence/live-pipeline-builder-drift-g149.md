# G149 production Pipeline Builder drift recheck

Date: 2026-09-10

The public dashboard shell is currently served as `/assets/index-4v75G2Yu.js`. Its referenced Pipeline Builder chunk remains `/assets/PipelineBuilderPage-BEjru09w.js` (HTTP 200, 181935 bytes). The deployed chunk still contains the alert-only `Pipeline saved!` handler and does not contain the local draft key or `localStorage` persistence.

The locally built dashboard chunk contains the corrected `djimitflo_pipeline_draft` validation/persistence path and no alert-only save string. `GET /api/version` remains `0.5.8`.

Conclusion: production is still behind the corrected local Pipeline Builder implementation despite a changed dashboard shell hash. No deployment or mutation was attempted.
