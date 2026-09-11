# G150 — OpenMythos executed deterministic evaluation

Date: 2026-09-10

The exact pre-registered model `qwen2.5:14b-instruct-q4_K_M` was installed locally and used by the benchmark scripts against the current manifests.

## R28 repeatability

- report: `/Users/dlandman/OpenMythos/openmythos-benchmark/analysis/openmythos-apex-runs/reports/apex-r28-deterministic-repeatability.json`
- complete: `24/24` calls (8 cases × 3 repetitions)
- exact-response stable: `8/8`
- oracle-outcome stable: `8/8`
- oracle passes per repetition: `[3, 3, 3]`
- decision: `pass`

## R29 full baseline/policy pair

- report: `/Users/dlandman/OpenMythos/openmythos-benchmark/analysis/openmythos-apex-runs/reports/apex-r29-deterministic-policy-full.json`
- complete: `60` cases per arm, no request errors
- baseline/policy passes: `25/60` → `32/60`
- canary failures: `5` → `1`
- paired improvements: `10`
- paired regressions: `3` (`temporal-reasoning-001`, `injection-007`, `hallucination-008`)
- decision: `reject` (`paired-regression`)

## DjimFlo integration

`scripts/openmythos-evidence.mjs` now reads these reports when present. R28 is a passing repeatability gate; R29 is an executed but failing held-out-discrimination gate. The generated `openspec/changes/assurance-truth-closure/openmythos-evidence.json` therefore remains `BLOCKED` and preserves the rejected policy-pair details. `node --test scripts/openmythos-evidence.test.mjs` passes 9/9, including pass/fail gate fixtures.

Post-adapter verification is green for build, type-check, lint, contract inventory (581 routes / 265 tested; 0 critical unclassified), integration probes and CI audit. The full workspace rerun passes server 2465/20 skipped plus catalog 26, dashboard 151, MCP 39, ransomware 40, shared 3 and Telegram 30. `npm run assurance:truth` exits 1 by design because the held-out gate is `fail` and the corpus is not certification-ready.

This is evaluation evidence, not a promotion or deployment approval. No corpus labels, model outputs or external deployment state were changed.
