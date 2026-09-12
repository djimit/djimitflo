# G82 — production/local pipeline drift

Captured 2026-09-09. The public production bundle is not behaviourally identical to the current local dashboard implementation.

Production asset:

```text
https://djimitflo.agentical.nl/assets/PipelineBuilderPage-BEjru09w.js
sha256 1a58ce401fb34a3fbc6e162e372c330d96415ec99aa8d0cd063b1dd98c3c1f45
```

The minified production chunk contains:

```text
onClick:()=>alert(`Pipeline saved!`)
```

for the Save control. It does not write or reload a pipeline draft. The local source at `packages/dashboard/src/pages/PipelineBuilderPage.tsx` instead validates the stored draft, writes `djimitflo_pipeline_draft`, restores it after remount and exposes storage failures rather than claiming success. The maintained local test was executed with the package's jsdom configuration:

```text
npm run test --workspace=@djimitflo/dashboard -- PipelineBuilderPage.test.tsx --reporter=verbose
Test Files 1 passed
Tests 3 passed
```

The local source/test hashes at capture were:

```text
PipelineBuilderPage.tsx      a3cfc3b043f87a16a452c972f30fd09d65552fd42811637799f4df9bea7c0203
PipelineBuilderPage.test.tsx f7fa929ff73a3d3ddcea702e2feed35085f4fbc2e62a2079d27aa87ba001529c
```

The fresh local dashboard build contains the corrected persistence handler in `packages/dashboard/dist/assets/PipelineBuilderPage-D21jsjMc.js` (`sha256 7a9c44e4854bf257a4a9b27dca8290b4555067b52dc13f2a3b0ebd67c663552b`). This is a deployable local artifact, not proof that production has been updated.

State: local implementation **SCOPED_PASS**; production deployment is **DRIFTED/UNKNOWN** until the corrected dashboard is built and deployed. No production mutation was attempted.
