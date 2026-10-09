# ruDevolution — capability matrix

Pin: ruvnet/rudevolution `b99ec70c780e249b151de5c32ee9839784671962` (2026-10-09; 16 commits by one author; 153 stars; no tool release — the 5 tags
ship decompiled Anthropic Claude Code; LICENSE truncated MIT → GitHub NOASSERTION; crates.io `ruvector-decompiler` 1 version).

| Capability asked for | ruDevolution | Label | DjimitFlo today | Gain |
| --- | --- | --- | --- | --- |
| Software intelligence on shipped JS | regex declaration scanner + partitioner (`src/parser.rs:50-66`), no AST | VERIFIED (static) | none | none usable (wrong output) |
| Module reconstruction | MinCut <5k decl., one-phase "Louvain" ≥5k (`partitioner.rs:49-53`) | FAILED (1 module on every real bundle) | none | negative vs trivial baseline |
| Identifier inference | substring table + Claude-Code corpus, else `helper_fn`/`composed_value` (`inferrer.rs:13-231`); no LLM | FAILED (0/571 exact) | none | none |
| Neural deobfuscation | `neural.rs`/`transformer.rs` never called; `model_path` unused; no weights | FAILED / CLAIMED (95.7 % = per-character on leaky split) | none | none |
| Dependency / module analysis | declaration-name edges only; no import/require resolution | INFERRED | SBOM, npm audit (manifest level) | none |
| Supply-chain assurance | none (no install-script, network-API or tarball analysis) | VERIFIED by absence | Trivy, audit, SBOM, CodeQL, Dependabot | none |
| Change / regression intelligence (release diff) | none | VERIFIED by absence | none | none |
| Security research | none beyond renaming | VERIFIED | red team, lure | none |
| Provenance / evidence | Rust witness: unkeyed SHA3 Merkle over input slices + name maps; output text and names excluded; tautological self-check | FAILED as assurance | authority ledger, P1 hash seal | negative (misleading) |
| Node witness v2 / Ed25519 attestation | domain-tagged, independently trusted key | VERIFIED (static only, not run) | — | none consumed |
| Safe remote fetch | HTTPS allowlist, 32 MiB, 30 s, redirects re-validated (`safe-fetch.js`) | VERIFIED (static) | — | — |
| Determinism | HashMap iteration order | FAILED (6/13 inputs differ across runs) | — | — |
| No network in core | no network crate compiled; clean run under `--network none` | VERIFIED | — | — |
| Never executes input JS | Rust: no engine; canaries not executed | VERIFIED (Rust) / INFERRED (Node) | — | — |
| EVE-V technical claim validation | output not semantics-preserving; names invented | FAILED for evidence use | adapter not installed | none |
