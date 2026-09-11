# G95 — build and assurance recheck

Commands:

```text
npm run build
npm run assurance:truth
```

`npm run build` exited `0`; all seven workspaces compiled and the Vite dashboard bundle was produced. `npm run assurance:truth` exited `1` with the expected fail-closed assurance result in `openspec/changes/assurance-truth-closure/evidence.json`: external OpenMythos evaluation evidence and live deployment identity prerequisites are still unavailable. This is a blocked assurance result, not a build failure and not a certification.
