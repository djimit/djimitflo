# TG-001 r1 — ABORTED_DATA_LOSS

Generation r1 of TG-001 ([protocol](TG-001_PROTOCOL.md)) is **ABORTED_DATA_LOSS**. Its plan is reused for r2. None of its data is.

## Timeline (UTC)

| When | What |
|---|---|
| ~2026-10-11T04:11Z | Time of the provider snapshot that production was later restored from |
| 2026-10-11T23:04:15.146Z | r1 manifest and analysis plan frozen on production (`tg_experiments.id = 'tg-001'`) |
| 2026-10-11T23:20:22Z | GO checklist recorded outside the server (the r1 record below) |
| 2026-10-11T23:25:18.735Z | First physical r1 attempt claimed |
| after that | About 5 attempts ran |
| later | The hosting provider restored the VPS from the ~04:11Z snapshot. The r1 manifest and every `tg_attempts` row are gone |

**Lost window:** from 2026-10-11T04:11Z to the recovery. Everything written in that window is **unverified**. That covers TG-001 and every other table.

## Status of r1

- The ~5 attempts are **UNKNOWN/LOST**. They are not failed, not completed, and never reconstructed as executed.
- r1 is never pooled with r2, and it is never counted in any analysis.
- r1 exists only as a read-only constant: `TG_PRIOR_GENERATIONS` in `packages/server/src/services/tg-001.ts`. The `tg_001` evidence section shows it as `prior_generations`. No r1 row is written to `tg_experiments` or `tg_attempts`.

r1 record (from the GO checklist):

| Field | Value |
|---|---|
| analysis_fingerprint | `ff29c34441f68804b0177b0599f673f369386e139234662eeb33f23d234e70ec` |
| task_set_fingerprint | `d0eee603a3afa4fbf1988f9bd9a26c4bc0564ae1d98e08d02755a578a57e1594` |
| prompt A / B / C / D | `1ca310dc…` / `fa7fdcc1…` / `5a8270f5…` / `8736acc0…` (full values in code) |
| seed | 11102026 |
| gate_version | `633dd7a096aba028eebff3228fd4a0cd23ec044cf089cd6caad95c4890a6ba47` |
| classifier_version | tg-classifier-v2 |
| step_budget | 40 |
| model_router | atomic@llama-router |
| worker | `scripts/gym-worker.mjs@sha256:409ef06ef0de45c091cd2705538b04ef1dafcc6940f9b9707f45d0bdb3f8a7d1` |
| git_commit | `a4f241c1a381bb4217f98450bdc83705520fbf19` |

## r2 rules

1. **Identity carries the generation.**
   - `TG_ID = 'tg-001-r2'` and the manifest records `generation: 'r2'`.
   - These keys use the generation: `tg_experiments.id`, `tg_attempts.experiment_id`, attempt ids (`tg-001-r2:<uuid>`), the run's `gym.tg` (`experiment`, `generation`), the claim's `tg` field and each attempt's result/history record.
   - `loop_runs.loop_name` stays `'tg-001'` (the isolation provenance).
2. **Only the current generation counts.**
   - A manifest or attempt row from another generation is never served, resumed, settled or pooled.
   - A result posted for a run claimed under another generation is rejected with `409 GYM_RUN_STALE_GENERATION`.
   - Claims and leases from before the restore never resume.
3. **Only the plan is reused.**
   - The generation stays out of the hashed analysis. `analysis.experiment_id` stays the plan id `'tg-001'`, so identical tasks, prompts and seed give identical fingerprints.
   - GO requires `plan_matches_r1`: the analysis fingerprint, task set, four prompt fingerprints, seed, gate_version, classifier_version, step_budget and model_router must all equal r1.
   - The analysis object also contains `frozen_at`, `commit` and `worker_version`, which a new generation cannot share. Its fingerprint is therefore re-hashed once with those three set to r1's exact values (`frozen_at` 2026-10-11T23:04:15.146Z from the prod probe).
   - Commit and worker may differ. They are listed under `plan_reuse.recorded_separately` and are not compared.
   - On a mismatch, `plan_reuse.differs` names each differing field and GO is false.
4. **The plan is derived from database state.** The task pool, the prior-exposure counts in the analysis, and the production findings behind prompts B, C and D are all read from the database at freeze time. The restore rolled the database back to 04:11Z, and runs after the restore add to it. An r2 freeze can therefore produce a different plan. If it does, the checklist reports which fields differ, and the operator decides; nothing is forced to match.

## Reconciliation rule

If the provider later supplies a newer disk image, mount it **read-only**. Compare it with production record by record before any selective reconcile. Never overwrite production with the image. Reconciled r1 rows would still be r1 (`experiment_id = 'tg-001'`), and r2 never serves or pools them.
