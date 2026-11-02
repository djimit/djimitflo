# ruDevolution — evidence matrix

Chain per finding: SOURCE → OBSERVATION → INFERENCE → VALIDATION → CONFIDENCE → DECISION.
Status vocabulary: OBSERVED, INFERRED, VERIFIED, UNKNOWN, CONTRADICTED. INFERRED is never promoted to VERIFIED without a reproduction.

| # | Source | Observation | Inference | Validation | Status | Confidence | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | README "MinCut detects module boundaries" | 1 module on 3 real bundles + 4.9k planted partition | partitioner collapses disconnected graphs into one orphan module | sandbox runs, B-cubed F1 0.011–0.200 vs baseline 0.636–0.771 | CONTRADICTED | 0.95 | reject claim |
| E2 | README identifier recovery | generic labels (`helper_fn`, `composed_value`), Claude-Code labels on unrelated code | substring table, no learning | 0/571 exact renames | CONTRADICTED | 0.95 | reject claim |
| E3 | `run_on_cli.rs:466-490` "100 % parse" | failed modules wrapped as strings, literal "(100%)" in log | parse rate is manufactured | own bundle output became a string literal | CONTRADICTED | 0.9 | reject claim |
| E4 | `witness.rs:3-4` integrity claim | root over input slices + name maps only | output/names/source hash not bound | different names → same root | CONTRADICTED | 0.9 | witness unusable as evidence |
| E5 | README 95.7 % neural accuracy | per-char metric, leaky random split, code not wired | marketing number | static read of training scripts | CONTRADICTED | 0.85 | reject claim |
| E6 | `run_on_cli.rs:461-483` | output path spliced into `node -e` script | code injection | `/work/INJECTED` created | VERIFIED (finding) | 0.95 | High-severity vulnerability |
| E7 | `parser.rs:89-191` | quadratic scan + body copies | DoS from small input | 469 KB → OOM 4 GiB | VERIFIED (finding) | 0.95 | resource risk |
| E8 | Rust dependency graph | no network crate compiled | core offline | `--network none` run, loopback only | VERIFIED | 0.9 | no network risk in core |
| E9 | Rust core input handling | no JS engine | input never executed | execution canaries absent | VERIFIED | 0.85 | — |
| E10 | Node `safe-fetch.js`, `safe-output.js`, `attestation.js` | allowlist, O_EXCL|O_NOFOLLOW, trusted-key Ed25519 | carefully written | static only, not run | INFERRED | 0.6 | not relied on |
| E11 | README "11 MB → 1,029 modules in 26 s" | not tested on proprietary input; 27.5k synthetic > 300 s | likely not reproducible at that speed | — | UNKNOWN | — | no reliance |
| E12 | DjimitFlo baseline | no minified-JS inspection; no consumer of bundle output | real gap but no current decision needs it | git grep / code read on `3eebe3bb` | VERIFIED (absence) | 0.85 | gap noted, owner = runtime-admission `supply_chain` gate |
| E13 | Releases and data files | decompiled Claude Code redistributed | licensing exposure | gh api release assets | VERIFIED | 0.9 | never mirror or ingest |

Rule applied: a cryptographically correct hash/witness was never treated as evidence of semantic correctness (and E4 shows the hash
coverage itself is incomplete).
