# ruDevolution — threat model

All input (bundles) and all output (code, names, folders, witness) is UNTRUSTED. Findings below are from the pinned commit
`b99ec70c`; "verified" means reproduced in the isolated sandbox (rootless docker, `--network none`, read-only root, cap-drop ALL,
no-new-privileges, 4 CPU / 4 GiB / 256 pids, non-root, no host mounts except a read-only copy of test inputs).

| # | Threat | Where | Severity | Status |
| --- | --- | --- | --- | --- |
| T1 | JS injection via output path: path spliced into `const dir='{}'` of a generated `node -e` "auto-fix" script | `examples/run_on_cli.rs:461-483`; Node wrapper passes `outputDir` straight through (`npm/src/decompiler/index.js:65-75`) | High | VERIFIED (`--output-dir` with `'` created `/work/INJECTED`) |
| T2 | Writes follow planted symlinks and overwrite targets | `run_on_cli.rs` `std::fs::write` (~447, 505-528, 555) | Medium | VERIFIED (victim files overwritten) |
| T3 | Memory/CPU exhaustion from tiny input (quadratic declaration-end scan, body copies) | `parser.rs:89-191` | Medium | VERIFIED (469 KB → OOM at 4 GiB in 2 s; 229 KB → 800 MB output) |
| T4 | Non-semantic output presented as decompiled code (refs not renamed, duplicate bindings, regex literal mangled, statements dropped, unparseable modules wrapped as strings and logged "100 %") | `beautifier.rs:77-125`, `run_on_cli.rs:466-476` | Medium | VERIFIED |
| T5 | Misleading integrity: witness root excludes output text, module names and source hash; unkeyed; self-check recomputes from same data | `witness.rs:88-159`, `lib.rs:105-109` | Medium | VERIFIED (different names → same root) |
| T6 | Prompt-injection propagation: injected strings become identifiers and folder names (`ignore_previous_instructions_e`) | inferrer / output layout | Medium for any downstream agent | VERIFIED |
| T7 | Non-determinism (HashMap order) breaks reproducible evidence | `partitioner.rs:157-230, 347-353`; `graph.rs:58-61` | Low | VERIFIED |
| T8 | Supply chain: README steers to unpinned `npx ruvector …` and `claude mcp add … npx ruvector mcp`; legacy CLI installs `npx ruvector@latest` hooks on every tool call and defaults to `https://pi.ruv.io` with `PI || 'anonymous'` | README; `npm/bin/cli.js:3543-3700, 7669-8016` | High if followed | VERIFIED (static; not active from checkout) |
| T9 | Symlinked input followed (read `/etc/passwd` via link) | CLI input handling | Low (normal CLI behaviour) | VERIFIED |
| T10 | Legal / IP: repo and releases redistribute decompiled Anthropic Claude Code; `data/claude-code-patterns.json` | releases, `dashboard/public/data` | High (licensing) | VERIFIED |
| T11 | Mojibake on non-ASCII (`bytes[i] as char`) corrupts evidence text | `beautifier.rs:120` | Low | VERIFIED |

Mitigated / not present: no network crate in the compiled Rust graph (VERIFIED, clean under `--network none`); Rust core never executes
input JS (VERIFIED with canaries); Node `safe-fetch.js` allowlist and `safe-output.js` O_EXCL|O_NOFOLLOW (VERIFIED static only);
no postinstall/preinstall scripts; no committed token found.

**If ever run** (not recommended): only as a throwaway research container exactly as in the sandbox above, Rust core only, never the npm
package, CLI or hooks, never with a caller-controlled output path, and every output treated as untrusted text — never as evidence.
