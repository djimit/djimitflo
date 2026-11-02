# ruDevolution — falsification report

Goal: try to show ruDevolution is NOT fit. Result: it fails on module boundaries, identifier recovery, semantic preservation, determinism,
resource safety and evidence integrity. **STOP condition met — nothing integrated.**

## Method

Pinned `b99ec70c`. Rust crate built `--locked --offline` and run in a rootless-docker sandbox on the workstation (`--network none`,
read-only root, tmpfs work dir, cap-drop ALL, no-new-privileges, 4 CPU / 4 GiB / 256 pids, uid 10001, 300 s kill timeout per input, no env,
no secrets). Ground truth: own 10-module project, 15 lodash-es 4.17.21 functions, holdout 10 date-fns 3.6.0 functions (MIT), bundled with
esbuild 0.24.0 (IIFE + minify + sourcemaps); each detected declaration mapped through the sourcemap to its true file and name. The Node API,
dashboard and clean-room code were reviewed statically, not run. Nothing from the repo ran on any other host.

## Claims vs results

| Claim | Result | Label |
| --- | --- | --- |
| MinCut detects module boundaries | 1 module for own (true 10), lodash (true 235), date-fns holdout (true 48) and a 4,900-declaration planted partition | FAILED |
| Louvain O(n log n) with aggregation | no aggregation phase exists; 6,000 decl. 37–40 s; 27,500 decl. > 300 s (killed) | FAILED |
| Self-learning (`learn_from_ground_truth`) | only splits feedback into two vectors; nothing learned; README's `NameInferrer::new()` does not exist | FAILED |
| Neural inference when `model_path` set | `model_path` unused; neural code never called | FAILED |
| 95.7 % val accuracy, beats JSNice | per-character accuracy on a random split of 8 synthetic variants per name (train/val leak); not wired into `decompile` | CLAIMED / misleading |
| 100 % parse (878/878) | failed modules wrapped as string literals, log prints a literal "(100%)" | FAILED (manufactured) |
| Witness proves every output byte derives from the bundle | root excludes output text, names, source hash; different names gave the same root | FAILED |
| `witness_chain.verify(&source)` API | does not exist | FAILED |
| Deterministic chain root | 6 of 13 inputs differ across two runs | FAILED in general |
| Output written exclusively, symlinks rejected | Node: VERIFIED (static); Rust CLI writes through planted symlinks | FAILED (Rust CLI) |
| Never executes input JS | Rust: canaries not executed | VERIFIED (Rust) |
| No network in core | no network crate; clean under `--network none` | VERIFIED |
| Tests pass | 61/61 Rust tests; they assert existence, not accuracy | VERIFIED (but weak) |
| Claude Code 11 MB → 1,029 modules in ~26 s | not tested on proprietary input; comparable 27.5k-declaration synthetic did not finish in 300 s | UNKNOWN |

## Adversarial inputs

| Input | Result |
| --- | --- |
| Malformed JS | no crash; 7 bogus declarations |
| Invalid UTF-8 | rejected at read |
| Non-ASCII source | mojibake ("héllo" → "hÃ©llo"); non-deterministic |
| javascript-obfuscator 4.1.1 output | 1 module; no name recovery |
| Unclosed `var aN={` ×N | 229 KB → 800 MB output, 1.57 GB peak; 469 KB → OOM-killed at 4 GiB in 2 s |
| 11 MB / 27.5k-declaration bundles | killed at 300 s |
| Prompt injection in strings/comments | becomes identifiers and folder names |
| `../../` in sourcemap paths | sourcemaps never read (pass) |
| Module names `../../../../tmp/pwned` | sanitised, stayed in output dir (pass) |
| Symlinks planted at output files | written through (FAILED) |
| `--output-dir` containing `'` | arbitrary JS executed (FAILED, High) |
| Network | none attempted (pass) |

Hashes or witnesses were never taken as evidence of semantic correctness; here even the hash coverage itself is incomplete.
