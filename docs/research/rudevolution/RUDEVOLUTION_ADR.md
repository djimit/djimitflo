# ADR — ruDevolution (ruvnet/rudevolution) for DjimitFlo

Status: decided (research) · 2026-10-09 · pinned `b99ec70c780e249b151de5c32ee9839784671962` · DjimitFlo `3eebe3bb`

## Context

The operator asked whether ruDevolution adds a demonstrably missing capability for software intelligence, JS bundle analysis, reverse
engineering, supply-chain assurance, change intelligence, security research, provenance and EVE-V technical claim validation. Evaluation:
DjimitFlo baseline from code; ruDevolution pinned and inspected read-only; dynamic falsification only in an isolated, network-less sandbox
(see the other six documents in this folder).

## Options

| Option | Capability gain | Security | Reliability | Evidence quality | Maintainability | Complexity | Licensing | Governance | Attack surface |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. No integration | none | unchanged | unchanged | unchanged | none | none | none | none | none |
| B. Improve existing DjimitFlo (static tarball/dist scan as evidence for the runtime-admission `supply_chain` gate and the dependency lane, using maintained parsers) | addresses the real gap | low, controlled | deterministic by construction | high (rules over real code) | ours | small | clean | inside existing gates | small |
| C. ruDevolution as temporary research tool | none measurable (F1 ≤ 0.2, 0/571 names) | High finding (T1) unless sandboxed | non-deterministic | misleading witness | external, single maintainer | Rust toolchain | NOASSERTION + Claude Code IP | outside gates | medium |
| D. Isolated Software Intelligence Worker | none (same as C) | sandboxable, but output poisons downstream (T6) | as C | as C | permanent burden | new worker + image | as C | needs new gate | medium-high |
| E. Adopt specific algorithms/concepts | none found worth adopting (regex parser, non-aggregating Louvain, unbound witness); the Node safe-fetch / O_NOFOLLOW patterns are standard practice we can write ourselves | — | — | — | — | — | licence unclear | — | — |

Gate: integrate only if CAPABILITY_GAIN > COMPLEXITY + SECURITY_RISK + MAINTENANCE_COST, reproducibly. For C, D and E the measured gain is
≈ 0 (below a trivial baseline) while every cost term is positive → gate fails.

## Missing DjimitFlo capability

Inspection of **shipped** JavaScript: npm package `dist/` code of the runtimes and dependencies DjimitFlo executes, release-to-release
diffs of that code, and detection of install scripts, network endpoints and dynamic code (`eval`, `new Function`, dynamic `require`).
Today the runtime-admission `supply_chain` gate (`execution/runtime-admission.ts`) accepts hand-written evidence strings for this, and the
dependency lane decides on semver + CI only. No current lane, gate, judgment or EVE-V hook consumes bundle analysis.

## Evidence

- Baseline: only `typescript` installed; every source walker skips `dist`/`node_modules`; grep for minif/sourcemap/tarball/decompil finds no
  analysis code (VERIFIED, `3eebe3bb`).
- ruDevolution: 1 predicted module vs 10/235/48 true; B-cubed F1 0.200/0.011/0.139 vs trivial baseline 0.771/0.705/0.636; 0/571 exact
  renames; 6/13 inputs non-deterministic; 469 KB input → OOM at 4 GiB; output-path JS injection reproduced; witness root ignores output text
  and names (all VERIFIED in the sandbox; RUDEVOLUTION_BENCHMARK.md, RUDEVOLUTION_FALSIFICATION_REPORT.md).

## ruDevolution advantage

None demonstrated. It is worse than a trivial contiguous-chunk baseline at module recovery, recovers no original names, does not preserve
semantics, and does not address supply-chain inspection at all. Simpler alternatives (option B) target the actual gap.

## Security cost

New attack surface: High-severity JS injection via output path (`examples/run_on_cli.rs:461-483`), symlink write-through, small-input
memory exhaustion, prompt-injection text propagated into identifiers and folder names, a witness that looks like integrity evidence but is
not, and a README that steers users to unpinned `npx ruvector@latest` hooks and an MCP server with `https://pi.ruv.io` defaults.

## Operational cost

A Rust toolchain (≥ 1.85) and a 161-crate dependency tree, a dedicated sandbox image and worker, a single-maintainer upstream with no tool
release, licensing ambiguity (truncated MIT) and redistributed decompiled Anthropic Claude Code in its releases — for a capability with no
consumer in DjimitFlo.

## Decision

**NO_GO.** Do not integrate, do not install the npm package, CLI, hooks or MCP server, and do not mirror or ingest its releases or data
files. The underlying gap is real: if the operator wants it closed, open a separate proposal for option B (a deterministic shipped-code
scanner feeding the existing runtime-admission `supply_chain` gate, shadow first), built on maintained parsers and our own tests.

## Confidence

**0.92.** Module and name recovery failed on three independent ground-truth bundles, including a holdout, and on synthetic planted
partitions; the security findings were reproduced, not inferred. Residual uncertainty: the Node API and clean-room path were reviewed
statically only, and the README's Claude Code speed claim could not be tested on proprietary input (UNKNOWN). Neither could change the
decision, because the Rust core is the component every path calls for reconstruction.

## Answer to the final question

> Which concrete capability does DjimitFlo get from ruDevolution that it demonstrably lacks today, and is it worth the extra attack surface,
> complexity and maintenance?

None. DjimitFlo does lack shipped-code inspection, but ruDevolution does not provide it reproducibly: its reconstruction is worse than a
trivial baseline and its names are 0/571 correct. The default decision applies: **NO_GO**.
