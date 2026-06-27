# Self-Learning Swarm Maturation

## Why

The real-runtime swarm is now **verified end-to-end**: a parallel, sandboxed, headless,
knowledge-injected, self-learning codex specialist swarm that runs `production_passed=true`
without mutating the host (evidence: `evidence.md`). That baseline is on `origin/main`
through `450edce`.

However, maturation is incomplete in ways that block *reliable* green proofs and the
"agentic OS" growth trajectory:

1. **Flaky integration gate.** `packages/server/src/__tests__/proof-run-service.test.ts`
   bridge tests do a full in-process proof run (git worktree add + `applySourceWorkingTreeDiff`
   + multiple fake-runtime spawns + deterministic checks) and intermittently blow the 5s
   vitest default. They passed during the green flywheel proofs but now time out on the
   workstation. Because the proof's `deterministic_checks` gate runs `proof:test`
   (this file), a flaky bridge test blocks `production_passed=true` non-deterministically.
2. **Wiki knowledge transfer reverted.** Writing promoted memory to the OKF markdown wiki
   (`sinks: ['okf','qdrant']`) broke the bridge tests; it was reverted to `['qdrant']`. The
   vector flywheel remains, but the human-readable wiki no longer accumulates learnings.
3. **Skills empty.** The OKF `skills/` directory is empty; no skill content is authored or
   injected. Specialists operate with retrieved memory + vector knowledge, but not explicit
   skills.
4. **opencode parity missing.** opencode fails its maker lease (`No api key passed in.` →
   401 from the LiteLLM proxy at `192.168.1.28:4000`) and has not been given the
   `--sandbox`/headless treatment codex has. No heterogeneous fleet yet.
5. **Scale unproven beyond 2.** Concurrency is verified for 2 nested specialists; the
   depth/budget/concurrency gates are untested at >2 concurrent specialists.
6. **Memory quality is shallow.** The flywheel stores run-summaries, not distilled rules.
7. **Hygiene gaps.** `pi-executor.test.ts` is absent (the Pi sovereign smoke is "No test
   files found"); prod `:3001` Mission Control needs valid operator creds.

This change matures the swarm from "verified once" to "reliably green + growing knowledge +
multi-runtime + scale", without re-architecting the verified baseline.

## Verified Baseline (already on `origin/main` — do not regress)

- Real codex swarm `production_passed=true`, `production_missing: []` (maker + checker +
  planner + memory_curator, all real codex).
- Worktrees **outside** the host repo; codex `--sandbox workspace-write` → host
  `tracked-changed: 0` across real runs.
- Nested specialists run **concurrently** (verified overlapping execution windows; runtime
  permit semaphore default 4).
- Knowledge injection: Qdrant api-key wired; OKF (78 pts) + DjimitKBWiki + swarm memory
  injected into maker assignments.
- Learning flywheel: promoted memory embedded (ollama `nomic-embed-text` 768d) + upserted
  to `djimitflo_swarm`; verified write→retrieve→accumulate (`djimitflo_swarm` 0→1→2 pts;
  proof B retrieved proof A's memory).
- `--ignore-user-config` cuts codex context ~73% (325k→87k input tokens, verified).

## What Changes

- **Bridge-test hardening**: raise/apply a real `testTimeout`/`hookTimeout` for the bridge
  tests, **and** eliminate the handle-leak/deadlock risk in the in-process proof run (the
  `afterEach` `server.close` hanging indicates an open handle). Mock or skip the flywheel's
  network sinks in tests (already gated by `PROOF_RUN_MEMORY_FLYWHEEL`).
- **Concurrent-edit handoff**: the workstation has uncommitted co-edits to
  `proof-run-service.test.ts` + `memory-candidate-service.ts`; reconcile with `origin/main`
  before any deploy so the timeout config + fixes actually land.
- **Wiki knowledge transfer (re-add, safely)**: promote to `['okf','qdrant']` **only after**
  the bridge tests are hardened; keep `writeSink('okf')` best-effort; optionally index OKF
  memory markdown into `djimit_okf` so wiki knowledge is retrievable via the OKF vector path.
- **Skills authored + injected**: seed real skill `.md` files in OKF `skills/`; inject
  relevant skill content (not just vector knowledge) into specialist assignment packets.
- **opencode parity**: mirror codex's sandboxed/headless invocation for opencode + configure
  the LiteLLM proxy API key → heterogeneous codex+opencode fleet, both knowledge-injected +
  self-learning.
- **Scale >2**: run >2 concurrent specialists, verify depth/budget/concurrency gates hold.
- **Memory quality**: evolve the memory-curator to distill actionable rules (not run-
  summaries) so retrieval returns useful knowledge.
- **Hygiene**: author `packages/server/src/__tests__/pi-executor.test.ts`; capture prod
  `:3001` operator creds.

## Non-Goals

- No re-architecture of the verified loop/lineage/usage/isolation baseline.
- No full OS-level sandbox (chroot/landlock/container) in this change — codex
  `--sandbox workspace-write` is the isolation mechanism; absolute-path escape by a
  determined runtime remains a documented residual risk (separate hardening change).
- No claim of "conquering the world"; this is a maturation plan with verifiable gates.
