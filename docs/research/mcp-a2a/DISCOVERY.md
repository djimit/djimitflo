# Discovery: tools that would close a measured Djimitflo gap

Read-only, checked 2026-10-21/22. Nothing was installed, run or registered. Pins come from GitHub release APIs and the
registries.

**Evidence labels.** **VERIFIED** means read in source code, an API schema or advisory data. **DOC** means taken from vendor
documentation, so treat it as a VENDOR_CLAIM. **INFERRED** means my own design reasoning.

## Gaps, with their source

| Gap | Measured symptom | Source |
|---|---|---|
| G1 Task supply on more repos | One repo live; extra-repo discovery covers node:test only; finding-fix lane sees about 46 findings; security-review-commons scanner is about 86 % false positive | L3 bottlenecks P1-3, P1-4; L3 v2 §5 #3; finding-fix-lane design §2a |
| G2 Graded test quality / settlement | 22/22 survived (the oracle cannot fail); 26/64 verified exports kill 0/3 mutants; graded is shadow-only | L3 v2 §5 #1, #2; `graded-fitness.ts:7-21` |
| G3 Failure-cause recording | `runtime_signal` null ×216; 50 cancels without a reason; about 44 % of non-verified outcomes are environment or reviewer noise | L3 v2 §5 #4, §6a |
| G4 Merge throughput | 42 verified changes waiting for merge; 285.8 operator-waiting minutes per surviving change | L3 v2 §5 #8 |
| G5 Provenance / supply chain | Unsigned bus events; unpinned tools | L3 bottlenecks P0-3, P5 |
| G6 Code navigation for makers in a second repo | Makers in unfamiliar repos (G1.1) | plan G1.1/G1.2 |

## Ranked candidates

| # | Candidate | Gap | Class | Effort | Reversible |
|---|---|---|---|---|---|
| D1 | StrykerJS features already pinned (10.0.0): `--mutate file:line-range`, `killedBy`/`coveredBy` per mutant, `--incremental`, `@stryker-mutator/tap-runner` | G2, G1 | **ADOPT_CANDIDATE** (no new dependency except tap-runner) | S–M | yes |
| D2 | Opengrep CLI with a small curated, vendored TS/JS rule pack | G1 | **ADOPT_CANDIDATE** (sandboxed trial) | M | yes |
| D3 | osv-scanner CLI `--offline` against a pinned DB snapshot | G1 (dependency findings), G5 | **ADOPT_CANDIDATE** (CLI only, not its MCP mode) | S | yes |
| D4 | OpenTelemetry GenAI `error.type` plus the makers' native OTLP (Claude Code, Codex) to a local receiver | G3 | **ADAPT_IDEA** (adopt the attribute vocabulary; no collector) | M | yes |
| D5 | GitHub artifact attestations (`actions/attest`, custom predicate) over the evidence bundle | G5 | **ADAPT_IDEA** / DEFER (only covers what runs in Actions) | M | yes |
| D6 | CodeQL code-scanning alerts via REST as a finding source | G1 | **ADOPT_CANDIDATE** for second repos (low supply on djimitflo: 2 alerts) | S | yes |
| D7 | TypeScript 7 native LSP (`tsc --lsp --stdio`) wrapped in our own MCP server as 3–4 read-only queries | G6 | **ADAPT_IDEA** (in-house) | M | yes |
| D8 | Merge with a bound head SHA (`sha` / `expectedHeadOid`) | G4 | **ALREADY_COVERED** (#914) | — | — |
| D9 | GitHub merge queue | G4 | **REJECT for now**: the repo is owned by a User, and merge queue needs an organisation | — | — |
| D10 | github/github-mcp-server (official) | G1/G6 context | **DEFER**: no gap needs it today | S | yes |
| — | oraios/serena, `mcp-server-git`, Semgrep MCP, sigstore/gitsign, anthropics/skills | — | **REJECT** (see the end) | — | — |

### D1. StrykerJS: use what is already pinned (G2, G1)
- **What it is.** `@stryker-mutator/core` and `vitest-runner` 10.0.0 (2026-08-14), Apache-2.0, maintained by the stryker-mutator org. Already in `package.json:44-45`.
- **Egress and telemetry.** Fully offline. A code search for telemetry found nothing (VERIFIED). The dashboard reporter is opt-in, so keep it off. No GHSA or OSV advisories.
- **Unused features** (DOC, except where marked):
  - `--mutate "src/x.ts:12-40"`, so a run mutates only the lines a change touched.
  - `coverageAnalysis: perTest`.
  - `killedBy`/`coveredBy` per mutant in the JSON report (VERIFIED in mutation-testing-report-schema).
  - `--incremental`.
  - `@stryker-mutator/tap-runner` for `node:test` repos.
- **Today.** `scripts/mutation-gain.mjs:14-31` scores whole-file Stryker runs before and after and compares the totals. `graded-fitness.ts` records `mutant_kill` / `mutation_score` in shadow only.
- **How it closes G2** (INFERRED):
  1. Replace the 14-day "line retention" settlement endpoint with an **executed** one. At day 14, re-run Stryker on the merged test, line-scoped to the target, against the then-current source. The endpoint is the count of mutants killed **only** by that test (present in `killedBy`, absent on the parent SHA). This endpoint can fail, which line retention cannot.
  2. A change that kills 0 new mutants is labelled "verified-ineffective", which addresses the 26/64.
- **How it closes G1.** tap-runner removes the "node:test only / no vitest" asymmetry for extra repos. To verify: whether tap-runner fits the second repos' runners.
- **Caveat.** Stryker issue #6240 reported per-test coverage misattribution after a Vitest 5 migration. We are on Vitest 4.1.11. Keep a known-score canary test before any Vitest major bump.
- **Operator ask:** none for shadow. The new settlement endpoint is a pre-registered change to the R2/Gate B protocol, so it needs an operator OK.

### D2. Opengrep with a curated rule pack (G1)
- **What it is.** Opengrep consortium (Aikido and others), a fork of Semgrep CE.
  - **Licence:** engine LGPL-2.1. The `opengrep-rules` fork is Commons Clause + LGPL-2.1, which allows internal use.
  - **Release:** v1.31.0 (2026-10-15), tag commit `87668f6dbd28a9b97bcaf294a564fe79e0a7b56e`. Release binaries carry cosign `.sig`/`.cert`.
- **Telemetry.** Metrics were removed (issue #158, closed 2025-07-07). No metrics endpoint in source (VERIFIED). Runs offline with local rule files. No GHSA advisories.
- **Exec / write surface.** A read-only scan with JSON/SARIF output.
- **How it closes G1.** Deterministic code-level findings per repo. The oracle is the same rule and file re-run: the finding is gone and tests are green. That is the same shape as the ESLint gate in `scripts/finding-fix-gate.mjs`, which already rejects `nosemgrep` / suppression comments (`:39`). Curating a small high-precision pack is what tackles the ~86 % false-positive rate.
- **Why not Semgrep.**
  - With registry rules or a login, `--metrics auto` sends metrics. `--config auto` refuses to run with metrics off (VERIFIED).
  - Registry rules are under the Semgrep Rules License (internal use only, no offering as a service), which conflicts with G4 "verified engineering as a service".
  - Semgrep MCP mode exports OTel spans to `telemetry.semgrep.dev` by default (VERIFIED, `cli/src/semgrep/mcp/utilities/tracing.py`).
- **Operator ask:** approve one pinned binary, verified by its cosign signature, on the VPS image or the workstation; agree the rule pack.

### D3. osv-scanner CLI, offline (G1, G5)
- **What it is.** Google, Apache-2.0.
  - **Release:** v2.7.0 (2026-10-12), tag commit `bfe2f84abd2f09fe0b83ba7f6dad40d296762f40`; linux_amd64 sha256 `160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b`.
  - **Image:** `ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0`.
  - **Provenance:** SLSA provenance attached.
- **Egress.** It calls osv.dev and deps.dev by default. `--offline --download-offline-databases` gives fully offline scans. No telemetry code (VERIFIED).
- **Exec / write surface.** `osv-scanner fix` may run package-manager scripts, so never use it on maker repos.
- **Do not use its MCP mode** (`experimental-mcp`). It builds scanner actions without the offline flag, and `get_vulnerability_details` always calls osv.dev (VERIFIED, `cmd/osv-scanner/mcp/command.go`).
- **How it closes G1.** One deterministic finding per vulnerable lockfile entry. The oracle is a re-run with `--offline` on the same DB snapshot: the vulnerability ID is gone and tests are green.
- **Honest limit.** It overlaps with dependabot (already on), and the fixes are mostly version bumps. The value is per-repo supply on repos without dependabot, plus a pinned and auditable vulnerability snapshot for assurance reports (G4.1).
- **Operator ask:** approve the pinned binary and a periodic DB snapshot pull. That is a new outbound target (`osv-vulnerabilities` bucket) from whichever host pulls it. Prefer the workstation, never prod.

### D4. OpenTelemetry GenAI vocabulary for failure causes (G3)
- **What it is.** `open-telemetry/semantic-conventions-genai`, Apache-2.0.
  - Agent spans are in **Development** status, so pin your own attribute list.
  - `error.type` is Stable, and conditionally required when an operation ends in error (VERIFIED).
- **Maker emitters.** Both are off by default and carry no prompt content by default (DOC):
  - **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` emits `api_error`, `tool_result` and `tool_decision`.
  - **Codex:** `[otel]` exporter emits `api_request`, `tool_result`, and so on.
  - **Watch out:** Codex sends anonymous usage analytics to OpenAI by default, separately from OTel. `[analytics] enabled = false` turns it off. Check this on the makers.
- **How it closes G3** (INFERRED). A closed failure enum on every lease close, `error.type` ∈ {`env.*`, `reviewer.*`, `maker.*`, `oracle.*`, `cancel.*`}, with the cancel reason NOT NULL. Optionally, makers send OTLP/HTTP JSON to a local Djimitflo receiver route, which fills `runtime_signal` from the runtime's own `api_error` / `tool_result` events. No collector is needed and nothing leaves the host.
- **Operator ask:** none for the vocabulary. Turning on maker telemetry is an env change on the maker host.

### D5. GitHub artifact attestations (G5)
- **What it is.** GitHub, MIT.
  - **Release:** `actions/attest` v4.2.2, commit `1e69f48acb82d1966a394da916b4c1698aa569d6`.
  - **Permissions:** needs `id-token: write` and `attestations: write`.
  - **Egress and cost:** public repos use public-good Sigstore (egress to Sigstore and GitHub); private repos need GHEC.
- **How it would close G5.** A CI job on the PR head SHA attests an evidence-bundle predicate: maker diff hash, verified SHA, oracle results. That signs the chain from diff to verified SHA. The link from verified SHA to merged SHA already exists (D8).
- **Limit.** It signs only what runs inside Actions. VPS-side oracles would need to be re-run or re-hashed in CI. For the unsigned bus events, use `node:crypto` Ed25519; no tool is needed (SECURITY_GAPS.md S3).
- **Status:** DEFER until the assurance report (G4.1) needs third-party-verifiable signatures.

### D6. CodeQL alerts as a finding source (G1)
- **What it is.** `GET /repos/{o}/{r}/code-scanning/alerts`. CodeQL already runs in CI (`.github/workflows/codeql.yml`).
- **Supply.** djimitflo has 2 open alerts (VERIFIED), so low supply here; the value is on second repos.
- **Licence limit.** The CodeQL CLI is free for automated analysis of OSS codebases only. Private repos need GitHub Advanced Security (DOC).

### D7. TypeScript 7 LSP, wrapped in-house (G6)
- **What it is.** `typescript@7.0.2` (Microsoft, Apache-2.0) ships `tsc --lsp --stdio` (DOC). It is local, with no egress.
- **Design (INFERRED).** Djimitflo spawns the repo's pinned TypeScript. It exposes only `definition`, `references`, `workspaceSymbol` and `diagnostics` as read-only tools on **our** MCP server, scoped to the lease worktree, and kills the process at lease end.
- **Precondition.** Makers have shown 0 MCP calls in 30 days (OUR_SURFACE.md §3), so the first step is making the makers' MCP actually start.
- **Why not Serena.** It is GPL-3.0, has an `execute_shell_command` tool, and had 3 RCE advisories in 2026 triggered by repo content or local network access: GHSA-37h2-6p4f-mp3q, GHSA-pp25-4cg4-qcr9 (critical), and GHSA-pp6p-xvxf-8hhx. That is exactly the unfamiliar-repo threat model.

### D8. Merge with a bound head SHA: ALREADY_COVERED
- `services/loop-auto-merge.ts:27-29,131-134` requires `metadata.verified_head_sha` and refuses `head_moved`.
- `:186` passes `sha` to the REST merge call (fixed in #914). That is the REST equivalent of GraphQL `expectedHeadOid`.
- **The remaining G4 cost is human merge latency, not tooling.** A one-click "approve this verified SHA" in the cockpit could cut operator minutes. That is product work, not a new tool.

### D9. GitHub merge queue: REJECT for now
`djimit/djimitflo` is owned by a **User** (`owner.type=User`, VERIFIED). Merge queue requires an organisation-owned repo. Transferring to an organisation is reversible but changes URLs, webhooks and GHCR paths. Revisit only if the transfer happens for other reasons.

### D10. github/github-mcp-server: DEFER
- **What it is.** GitHub, MIT.
  - **Release:** v2.0.3 (2026-10-21), `ghcr.io/github/github-mcp-server:v2.0.3@sha256:250bc6ce70788207608ef74cef4397230ff2e8481218da74d6093e4bd9101132`.
  - **Hardening flags:** `--read-only`, `--toolsets`, and `--lockdown-mode`. The docs say lockdown is "not an authorization boundary".
  - **Advisories:** CVE-2026-48529 (HTTP-mode lockdown confusion, fixed in 1.1.2) and CVE-2026-47427 (pre-auth DoS, no patched version listed).
  - **Release cadence:** 4 releases in 15 days, including a major.
- **Fit.** No gap needs it. Makers get the issue text in the assignment.
- **Note:** the operator's own Claude Code runs a local binary build of it (`~/go/bin/github-mcp-server`, PAT via env). Check that build's version against the two advisories.

## Checked and rejected

| Candidate | Reason |
|---|---|
| oraios/serena | 3 RCE advisories in 2026 triggered by repo content; GPL-3.0; shell tool |
| `mcp-server-git` (modelcontextprotocol/servers) | CVE-2025-68143/68144/68145, CVE-2026-27735 (path and argument injection); Djimitflo already owns git |
| Semgrep MCP / Semgrep registry rules | Telemetry on by default in MCP mode; rules licence forbids offering as a service |
| sigstore/gitsign | Keyless signing needs a browser OIDC flow plus egress; verifier CVEs 2026-44309/44310; plain SSH commit signing with a Djimitflo-held key is simpler |
| anthropics/skills | No gap fit; mixed licence (the docx/pdf/pptx/xlsx skills are source-available) |
| Vitest per-test coverage | Not a Vitest feature; Stryker `perTest` is the per-test source |
