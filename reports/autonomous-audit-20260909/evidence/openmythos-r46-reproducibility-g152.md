# G152 — OpenMythos R46 cross-validation reproducibility

The retained R46 script initially referenced a deleted Claude scratchpad, so it could not be rerun from the repository. The script was minimally repaired to load the adjacent retained `r45-evidence/apex-r45-results.json`, with `R45_RESULTS_PATH` available for isolated fixtures.

Re-execution completed deterministically:

- 2,000 stratified 50/50 splits
- learned per-category selector: `0.538`
- always-route baseline: `0.551`
- always-discriminator baseline: `0.551`
- learned selector wins over route: `0/2000`

The result remains `refuted`: the R45 selective hybrid is overfit, category routing remains the best validated method, and no selector/router change is promoted. This is a reproducibility repair and measured negative learning, not a model or production change.
