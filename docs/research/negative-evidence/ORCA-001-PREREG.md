# ORCA-001 — bounded evaluation of Orca as a supervisor for workstation attempts (DRAFT, not frozen)

Status: **draft**. NE-017 is `REOPEN_CANDIDATE` (operator decision 2026-11-07). This file is frozen, with its sha256
recorded in `NEGATIVE_EVIDENCE.yaml` (`reopen.prereg_sha256`), only after step 2 below. Until then nothing about Orca
runs on a DjimitFlo path, and NE-017's forbidden patterns stay enforced.

## Why it is reopened, and what would have to be true

NE-017's reopen condition has two parts, and neither holds today:

- **(a) A measured gap that only Orca closes.** The only candidate is supervision of attempts on the workstation.
  Measured on prod, 30 days to 2026-11-07:
  - remote gym: 946 attempts, 55 lost as `infra: maker crashed or timed out without a change` (5.8 %), 3 lost results;
  - remote maker jobs: about 80 done; 42 cancelled. Of those, 20 were `lease_not_active;late_result` (the #947 bug,
    fixed 2026-10-29), 7 `work_timeout`, 6 `queue_timeout` and 9 with no reason recorded.

  The in-house worker could also close the gap: the planned cancel channel (gap-matrix PR5) plus the orphan sweep.
  So Orca has to beat the in-house worker on the same tasks, not just beat nothing.
- **(b) Orca running inside the workstation pull worker behind `remote_maker_jobs`, at a pinned version with a
  contract snapshot.** No host has an Orca binary yet.

## Pinned version

- `stablyai/orca` **v1.4.251** (released 2026-11-06), asset `orca-linux.AppImage`, size 251 993 971 bytes. Its sha512
  from the release's own `latest-linux.yml` is
  `03eShr3r4AcHorSCF0SDDvCgfeY5IwSQx/zbRYXVdowR5iELHHRgcndyhh17r2se5JgdAfZ2eVcic22O6NXPvQ==`.
- Caveat: the checksum comes from the same release as the binary, so it proves integrity, not provenance. Releases
  come out almost daily, so the version is pinned and never `latest`.
- Install: user `djimit` on the workstation, extracted (no root, no `.deb`), with `ORCA_TELEMETRY_DISABLED=1` and
  `DO_NOT_TRACK=1`, and no Relay or skill-link sharing. This is the operator's step.

## Steps (each gates the next)

1. **Install and snapshot (operator, then me).** The operator installs the pinned build and runs `orca --version`,
   `orca status --json`, `orca skills get orchestration --full` and `orca skills get orca-cli --full`. The output
   is committed as `docs/orca/cli-snapshot-1.4.251.md`. It is the only contract the adapter may implement against.
2. **Freeze this protocol.** Fill in the open fields below from the snapshot, then record the sha256 and set NE-017
   to `PREREGISTERED_EXPERIMENT`. Open fields:
   - can a worker run the same agent as the in-house arm (`atomic-agent` against llama-router)? If Orca only runs
     claude/codex/opencode/qwen, the arms differ in species and the comparison is confounded;
   - does `orca serve` run headless on the workstation without a display?
   - how are dependencies declared, what is the exact JSON of run, task, worker, check, gate and dispatch, and what
     exit codes do they use?
3. **OpenSpec change `add-orca-runtime-adapter`** with the port, the adapter and a fake. `RUNTIME_ORCA=off` by
   default. Only `OrcaCliAdapter` may call the binary (argv only, never a shell). Orca output is untrusted data.
   DjimitFlo keeps the dispatch state, policy, gates and evidence.
4. **Run.** The two arms are randomised per task (sha256 of the task key) on mutant-repair gym tasks, inside the
   existing remote gym cap, on the workstation only. Real goals and prod makers are never touched.

## Decision rule (to be frozen in step 2)

- **Primary:** the infra-loss rate per attempt: crashed or timed out without a change, lost result, or orphaned.
  Arm Orca vs arm in-house worker, two-sided Fisher exact test at α 0.05.
- **Power:** at a 5.8 % baseline and about 280 attempts per arm (14 days at half of the 40/day cap), only a
  near-elimination is detectable (5.8 % → 1 %, power ≈ 0.8). A halving is not detectable at that size.
- **Secondary (descriptive):** verified rate, wall time, cancel latency, and orphans after a timeout.
- **SUPPORTED:** a lower infra-loss rate with p < 0.05, and no lower verified rate (upper bound of the difference
  ≤ 5 pt). → NE-017 condition (a) is met for supervision only, and still not for isolation (S0).
- **REJECT stands:** otherwise, or when step 2 shows the arms cannot run the same agent.

## Never in scope

- Orca on the VPS, a desktop pushing work to the workstation, or Orca as the source of truth for flow state.
- Citing Orca for S0 maker isolation: Orca has no sandbox.
- Relay, skill-link sharing and telemetry.
