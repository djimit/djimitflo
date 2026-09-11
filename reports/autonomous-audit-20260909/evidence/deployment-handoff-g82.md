# G82 deployment handoff

The corrected local Pipeline Builder is present in the audit checkout and its fresh dashboard build contains the persistence handler:

```text
source: packages/dashboard/src/pages/PipelineBuilderPage.tsx
dist:   packages/dashboard/dist/assets/PipelineBuilderPage-D21jsjMc.js
dist sha256: 7a9c44e4854bf257a4a9b27dca8290b4555067b52dc13f2a3b0ebd67c663552b
local regression: 3/3 passed
```

The production asset currently served at `PipelineBuilderPage-BEjru09w.js` is a different artifact and retains the alert-only Save handler. The repository CI workflow builds/tests/scans but contains no deployment job; deployment documentation requires an explicit operator action. No push, merge, container publish or production mutation was performed. After an authorized deployment, rerun the public asset hash check and authenticated browser Save→reload smoke before closing G82.
