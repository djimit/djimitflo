# ruDevolution — benchmark

Harness: `decompile()` with default config, pinned `b99ec70c`, sandbox as in the falsification report. Ground truth via esbuild 0.24.0
sourcemaps. Single runs unless stated; n = declarations found by the tool.

## Real bundles

| Metric | own (10 modules) | lodash-es (15 fns) | holdout date-fns (10 fns) |
| --- | --- | --- | --- |
| Modules predicted / true | 1 / 10 | 1 / 235 | 1 / 48 |
| Declarations (n) | 27 | 545 | 108 |
| B-cubed P / R / F1 | 0.111 / 1.0 / **0.200** | 0.005 / 1.0 / **0.011** | 0.075 / 1.0 / **0.139** |
| Pairwise F1 | 0.143 | 0.007 | 0.124 |
| **Trivial baseline** (contiguous chunks, true count) F1 | **0.771** | **0.705** | **0.636** |
| Top-level declaration recall (approx.) | 24/28 = 0.86 | 303/404 = 0.75 | 79/137 = 0.58 |
| Identifier rename exact-match precision | **0/23** | **0/464** | **0/84** |
| Dominant inferred names | utility_fn ×8, helper_fn ×7 | composed_value ×239, helper_fn ×152 | helper_fn ×44 |
| Time / peak RSS | 1.6 ms / 5.2 MB | 21.7 ms / 6.6 MB | 3.7 ms / 5.1 MB |
| Output bytes (in → out) | 3,343 → 6,884 | 38,114 → 221,952 | 25,233 → 32,674 |
| Deterministic over 2 runs | no | yes | yes |

Identifier totals: **0 of 571** scored renames match the original name. False-positive renames: 571/571 (every rename is wrong or generic).

## Synthetic planted partitions (communities of ~50)

| Input | Path | Result |
| --- | --- | --- |
| 4,900 declarations | exact MinCut | 1 module, F1 0.02, 3.9 s |
| 6,000 declarations | Louvain | 1,107 vs 1,134 modules on two runs; B-cubed P 0.895 / R 0.124 / F1 0.218; 37 s, 27 MB; not deterministic |
| 27,500 declarations | Louvain | > 300 s, killed |
| 11 MB / 200k declarations | Louvain | > 300 s, killed |

## Footprint

Rust: 161 crates in Cargo.lock (regex, sha3, rayon, memchr, serde_json; optional `ort` for an unused neural path). Build requires a Rust
toolchain ≥ 1.85 (built with 1.99.0). Node: root package has zero deps; dashboard has its own lockfile (react 18, vite 6). Operational
complexity: a new language toolchain and container image for a capability with no consumer.

## Reading

A trivial contiguous-chunk baseline beats ruDevolution's module recovery by 3.5–64× on F1. Name recovery is zero. The measured numbers do not
support any DjimitFlo use.
