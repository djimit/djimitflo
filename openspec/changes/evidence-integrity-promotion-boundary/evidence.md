# Evidence

Verified on 2026-07-27 in the isolated repair worktree.

## Runtime integrity

- JSON agent messages and command output containing `trust boundary` produce no
  runtime warning.
- Explicit `runtime.error` events and stderr diagnostics preserve source and
  event-type provenance.
- Real makers now resolve to `changed`, evidenced `no_change_required`, or
  `failed`.
- A no-change disposition requires a structured non-empty reason and cancels
  unused checker leases.
- The deterministic mock runtime remains an explicit control-flow harness and
  does not claim repository mutation.

## Evaluation integrity

- `OpenMythosEvalService` records the exact corpus path and SHA-256 in run
  metadata.
- SEGML resolves the original prompt, expected behavior, failure mode and
  rationale from that exact corpus.
- A corpus hash mismatch or missing source lineage prevents draft generation.
- Generated cases stay `validated = 0`.
- The direct canonical corpus append implementation and auto-approve setting
  are removed.

## Calibration boundary

The current persisted runtime has eight Judge verdicts and zero calibrated
actual outcomes. It also has zero persisted OpenMythos runs and zero governance
feedback loops. There is therefore no valid sample for a Judge-to-loop quality
gate. The transfer remains shadow-only; no enforcement or recovery dependency
was added.

Self-analysis now labels its three material limitations and identifies its
hotspot method as `file-line-count-size-proxy`. Three repeated runs were
identical:

- 353 source files and 80,340 lines;
- 69 routes;
- 22 routes with HTTP and service evidence;
- 47 static integration evidence candidates;
- 405 dead-export and 160 unreachable-branch regex candidates;
- 144 file-size hotspots.

## Gates

- Focused runtime, SEGML, self-modification and loop tests: 73 passed, 1 skipped.
- Focused integration tests: 19 passed.
- Server suite: 1,660 passed, 19 skipped.
- Full workspace: 1,754 passed, 19 skipped.
- Three self-benchmark runs: 3/3 each.
- Type-check: passed.
- Lint: passed.
- Build: passed.
- OpenMythos canonical corpus: 351/351 valid.
- Skill lifecycle: 18 drafts, 6 stages, exact oracle coverage, no promotion.
- `git diff --check`: passed.

## Remaining human gates

No production database was mutated and no runtime was restarted. Canonical
benchmark promotion, merge, deployment, commit and push remain explicit human
actions.
