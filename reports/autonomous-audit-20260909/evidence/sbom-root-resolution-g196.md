# G196 — SBOM workspace-root defect and repair

The focused HTTP contract first failed from the npm workspace cwd with `components.length === 0`, proving that `process.cwd()` caused the SBOM route to miss the repository lockfile.

Repair: `resolveRepositoryRoot()` is now shared by SBOM and self-modification. The focused self-modification/SBOM/repository-index contracts pass after the repair, and SBOM generation contains actual lockfile components.
