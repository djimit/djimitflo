# OCR adapter: design (shadow-only additional reviewer)

Status: **design**. The pure parts are built and tested:
- `packages/server/src/services/ocr-review-adapter.ts`
- `packages/server/src/__tests__/ocr-review-adapter.test.ts`

Nothing spawns OCR. Nothing is wired to merges, PR comments, commit statuses, checker verdicts or loop gates.
The flag is `OCR_SHADOW_REVIEW_MODE`: `off` (default) or `shadow`. There is no acting value.

Evidence levels follow CAPABILITY_INVENTORY: VENDOR_CLAIM, OWN_MEASUREMENT, VALIDATED_LESSON.

## 1. Native bounded review task or delegation mode

| | Native `ocr review` (chosen) | Delegation `ocr delegate` inside an existing agent |
|---|---|---|
| What reviews | OCR's own pipeline: grouping, plan, N rounds, filter, re-location, on a model we pick | The host agent's model and prompts. OCR only supplies the file list and the rule text |
| Coverage accounting | Machine-written `ocr.run-manifest/v1` with typed failures (OWN_MEASUREMENT, `internal/session/manifest.go`) | The host agent's self-report (`coverage_rate` in the skill text) |
| Independence from our checker | Settable: a model family and provider different from glm/kimi on Ollama | Same as whatever executor hosts it. In opencode that is the checker's own family |
| Relation to vendor numbers | VENDOR_CLAIM numbers exist for OCR versions v1.3.1 and v1.8.7, not for this pin | **None.** It is a different execution and must be measured on its own |
| New moving parts | One binary, one provider credential, a synthetic `HOME` | A second prompt layer in an executor we already run, plus OCR's binary for preview and rules |
| Cost knob | `--max-tokens-budget`, `--effort`, `--concurrency` | The executor's own brake |

**We choose native mode, as one bounded review task per frozen input.** Reasons:
1. **It is the only thing that tests OCR's claim.** Delegation mode is "our checker with a different checklist". If it
   found more, that would say something about prompts in our checker, not about OCR as an additional reviewer.
2. **It is the only mode whose coverage is machine-accounted.** The adapter can reconcile that accounting against our
   own diff. A self-reported coverage rate from an LLM is not evidence under E2.
3. **It is the only mode where independence is real.** Delegation inside opencode inherits the checker's model family.
   `ReviewerIndependenceService` would mark it correlated (FAIL) whenever the host model equals the checker model.

Delegation mode stays out of the first trial. If it is ever wanted, it gets its own protocol and its own spend line. No
native result transfers to it.

## 2. Shape: an isolated runner behind runtime admission, recording shadow judgments only

```
frozen input (repo, base_sha, head_sha) ──► throwaway checkout (hooks off, .opencodereview/ removed, read-only)
        │                                              │
        │ git diff --name-status -z --find-renames     │ ocr review --preview --format json   (no LLM: exclusion reasons)
        ▼                                              │ ocr review --from base --to head --format json --audience agent
  denominator (DiffItem[])                             │     --rule <trusted copy> --provider P --model M --effort E
        │                                              │     --concurrency C --timeout T --max-tokens-budget B --output <out>
        └──────────► evaluateOcrRun() ◄────────────────┘   native binary, synthetic HOME, built env, wall-clock kill
                         │
                         ├─ buildOcrProvenance()    ─► judgments row: judgment='ocr_shadow_review', mode='shadow'
                         └─ assessOcrIndependence() ─► same row (vs the maker; in the trial vs the checker)
```

### 2.1 Admission

**When it applies**
- `checkAdmission('ocr', observedVersion)` (`execution/runtime-admission.ts:91`) is the "may we use it at all" check.
  Any in-product use goes through it.
- The first trial is an **offline harness** in a throwaway container, like SEC-F1 (`docs/research/eco/SEC-F1_RUN.md`).
  It never enters the `ExecutionEngine`. Admission therefore does not gate the trial.
- The assessment below is still written before the run. A REJECT finding stops the trial.

**Draft ledger record (not committed to the ledger in this PR)**
- **licensing: PASS.** Apache-2.0 (`LICENSE`, `package.json`). The transitive Go licences are still owed.
- **reproducibility: NOT_PROVEN.** The pin `375f64cd` is not a release. Two ways to prove it:
  - (a) A source build at the pin with Go 1.26.9 and `CGO_ENABLED=0`, done twice, with the same sha256 both times. The
    sha256 is recorded in this repo.
  - (b) Re-pin to `v1.13.2` and verify the GitHub attestation and `sha256sum.txt`. The sha256 is copied into this repo.
- **supply_chain: NOT_PROVEN.**
  - Pass condition: the checksum is held in this repo (the atomic precedent, `runtime-admission.ts:165-166`), there is
    no npm and no postinstall, and `go.sum` and the advisories have been reviewed.
  - **The npm install path would be a FAIL**: it uses a same-origin checksum, the openhuman precedent at :198.
- **interface: NOT_PROVEN, provable.** JSON plus `ocr.run-manifest/v1` with versioned coverage. The fake-output tests
  already cover the contract. A real conformance probe is still owed.
- **containment: NOT_PROVEN.**
  - In place: a synthetic `HOME`, a constructed env, a read-only checkout, and no MCP servers.
  - Missing: network egress restricted to the provider host. That needs a container network policy, which is the same
    gap opencode has.
- **lifecycle: NOT_PROVEN, provable.**
  - OCR's own bounds: `--timeout`, `--max-tokens-budget`, `--concurrency`.
  - Djimitflo's wall-clock kill via `startRuntimeProcess`/`stopRuntimeProcess` (`executors/runtime-process.ts`).
  - Cancel is SIGINT, which OCR handles gracefully and records in its manifest.
- **evidence: PASS-able.** Djimitflo computes coverage from its own diff and stores its own record. OCR's session store
  sits in a throwaway `HOME` and is never read as evidence.
- **gym_evidence: NOT_PROVEN.** The paired trial (EVAL_PROTOCOL) is that evidence.
- **authority:** all `DJIMITFLO`. OCR decides nothing: no merge, no status, no comment, no verdict.
- **child_agents: `RUNTIME_INTERNAL`.** OCR runs one sub-agent per file group, and they are invisible to Djimitflo.
- **capability_gap: NOT_PROVEN** until the trial.

**Consequence: BLOCKING for productisation, not for the trial.**
- `decide()` returns HOLD while `child_agents` is `RUNTIME_INTERNAL` (`runtime-admission.ts:64`).
- opencode only runs because it is `LEGACY_ADMITTED`, and a new runtime cannot get legacy status.
- So even an EXPAND outcome cannot put OCR in the engine until the operator rules on internal sub-agents for a
  **read-only, no-authority reviewer**. One option is a `conditions` entry that names the enforcing mechanism. Another
  is a ledger change reviewed as code.

### 2.2 Process

**Binary**
- The **native binary** only, at the pinned sha256. Never `bin/ocr.js`: it spawns `npm i -g …@latest`, see
  CAPABILITY_INVENTORY B1.
- `OCR_NO_UPDATE=1` is set anyway.
- The `ocr version` output is checked with `versionMatches`.
- Git ≥ 2.41 must be on PATH.

**Environment: constructed, not `buildExecutorEnv`**
- Contents: `PATH`, `HOME=<ephemeral 0700 dir>`, `TMPDIR`, `LANG=C.UTF-8`, `OCR_NO_UPDATE=1`, `OCR_LLM_TIMEOUT`, and
  **exactly one** provider key variable.
- Why not `buildExecutorEnv`: it passes the real `HOME` and every API key. OCR would then find `ANTHROPIC_*` env vars,
  `~/.zshrc` exports and `~/.opencodereview/rule.json` (resolver order, CAPABILITY_INVENTORY B1).
- Not set: `OCR_ENABLE_TELEMETRY` and `OTEL_*`. Removed: `DB_PATH`, `DJIMITFLO_CONTROL_URL` and
  `DJIMITFLO_SPAWN_TOKEN`, as in the SEC-F1 runner.

**Synthetic `HOME/.opencodereview/config.json`, written by the adapter**
- `provider`, `model`, `effort`, `language: English`.
- `telemetry.enabled: false`.
- No `mcp_servers`.
- No `api_key_cmd`: `config.json` is trusted input and can execute commands (CAPABILITY_INVENTORY B1).
- No global `rule.json`.

**Checkout**
- A fresh clone of the frozen repo state, with `core.hooksPath=/dev/null`.
- **Delete `<checkout>/.opencodereview/`** after recording whether it existed and its tree hash. The reviewed change
  must not supply rules.
- `--rule docs/research/ocr/trusted-rule.json`, read from a trusted pinned copy. A catch-all custom entry also shadows
  any project or global entry for rule text, so this is belt and braces.
- The checkout is mounted read-only where the runner allows it. OCR writes only to `HOME` and `--output`.

**Calls**
1. `ocr review --preview --format json …`: no LLM call. It gives exclusion reasons per path.
2. `ocr review --from <base_sha> --to <head_sha> --format json --audience agent --output <out>/result.json
   --rule <trusted> --provider P --model M --effort <E> --concurrency <C> --timeout <T>
   --max-tokens-budget <B>`.
- **The base must be an ancestor of the head.** `merge-base(base, head)` then equals `base`. The adapter checks this
  through the manifest's `input.resolved_base` (`ocr_input_sha_mismatch`).

**Bounds (from the existing execution layer)**
- One OCR process at a time: `RUNTIME_MAX_CONCURRENCY` in product; sequential in the trial.
- Inside OCR: `--concurrency 2`.
- `--timeout` 10 min per subtask.
- Djimitflo wall-clock kill at `timeout × rounds + 5 min`.
- Per-item `--max-tokens-budget`, plus a run-total cap in the harness.
- A kill by Djimitflo gives `terminated_by` and INSUFFICIENT_EVIDENCE.

### 2.3 Evaluation and recording: the built pure parts

| Function | Does |
|---|---|
| `parseNameStatusZ` | Builds the denominator from **our** diff. It covers add, modify, delete, rename, copy and type change, with similarity. An unknown status is an error, never a guess |
| `isTestPath` | Djimitflo's own test classifier. OCR's default excludes do not define what a test is |
| `computeCoverage` | Gives each diff item exactly one of `reviewed`, `validly_reused`, `covered_by_control`, `out_of_scope_policy` or `unreviewed`, with a reason. Also lists OCR items outside the frozen diff. See COVERAGE_CONTRACT |
| `evaluateOcrRun` | Returns `COMPLETE`, `PARTIAL`, `SKIPPED`, `FAILED` or `INSUFFICIENT_EVIDENCE`. Gate is E2 `GateStatus`; `accepted` is always the literal `false` |
| `buildOcrProvenance` | Records adapter and OCR version, source revision, binary sha256, auto_update `disabled`, provider and model, policy ref with trusted and observed rule hash, observed runtime-config hash, toolset (tools config, MCP servers), base and head SHA, bounds, outcome, gate, reasons, coverage counts, findings count, tokens (`null` when OCR reported none, never 0), duration, exit code and termination |
| `assessOcrIndependence` | Runs `ReviewerIndependenceService.assess` with `leaseIdentity` metadata. Same family or provider is correlated (FAIL). Unknown identity is UNDETERMINED. OCR's internal filter and reflection passes use OCR's own model and are never counted as an independent review |

**Where results go (future runner, shadow only)**
- One `judgments` row via `insertJudgmentRow`: `judgment='ocr_shadow_review'`, `mode='shadow'`.
  - `decision` is the outcome.
  - `model` and tokens come from provenance.
  - `provenance_json` holds the provenance record plus findings as (path, lines, severity, category, content sha256,
    in_diff).
- This follows the `judgments`-as-shadow-store convention used by `outcome_attribution` and `finding_fix_candidates`.
- No jev or System One call is involved. jev is never used for code or review decisions.
- No `policy_violations` row: an OCR finding is not a policy breach.

**What the runner will never touch**
- `submitCheckerVerdict` and `executeChecker` gates.
- `github-pr-review-service` (comments, Commit Status API).
- `loop-auto-merge`.
- Loop verification gates.
- `worker_leases.metadata.verdict`.

A test asserts that the adapter module imports none of these.

### 2.4 What is not built (and why)

| Missing piece | Why it is not built |
|---|---|
| Process wrapper (spawn, env builder, synthetic `HOME`, checkout prep) | Running OCR was out of scope. It is about 150 lines on top of `startRuntimeProcess` |
| Trial harness script, `scripts/ocr-pair-run.mjs` | It needs the operator's choice of provider and model, plus the frozen F1 set (EVAL_PROTOCOL §2) |
| Runtime-admission ledger record | It would be HOLD and inert, and the trial runs outside the engine. It is added with the wrapper |
| `OCR_SHADOW_REVIEW_MODE` entry in `EVOLUTION_FLAGS` and the runbook | Nothing reads the flag at runtime yet. It is registered with its first caller |
| `trusted_rule_sha256` value | It is OCR's own hash and can only be observed by running the pinned binary once. That is the first authorized step. Until then everything is INSUFFICIENT_EVIDENCE by construction (`trusted_rule_sha256_not_recorded`) |

## 3. Risks (OWN_MEASUREMENT from source unless marked)

1. **The reviewed change controls OCR's scope and rules** through `.opencodereview/rule.json`, which is loaded next to
   `--rule`.
   - Mitigation: delete the directory, use a trusted `--rule` catch-all, and check the hash
     (`ocr_rules_not_trusted_copy`).
   - A change that touches the directory is always flagged `review_config_in_change`.
2. **Silent self-update through the npm launcher.** Mitigation: native binary only, plus `OCR_NO_UPDATE=1`.
3. **Ambient credential discovery** (Claude Code env, shell rc files) and **`api_key_cmd` executes config.**
   Mitigation: synthetic `HOME`, constructed env, no `api_key_cmd`.
4. **Code leaves the host for the provider.**
   - The trial items are public: SEC-F1 sources are MIT/Apache, and the djimitflo repo is public.
   - Any product use on private repos is a separate operator decision.
5. **Exit 0 on partial and skipped runs.** Handled by the coverage contract: the exit code is never evidence.
6. **Test files and deletions are not reviewed by default.**
   - Tests are handled by the trusted `include: ["**/*"]`.
   - Deletions remain `unreviewed`, so the run is PARTIAL unless another control covers them.
7. **Precision.** VENDOR_CLAIM precision of 32-38 % means about 2 in 3 findings are unmatched. Triage cost is a primary
   metric (EVAL_PROTOCOL §5).
8. **Session store keeps source excerpts.** It lives in the ephemeral `HOME`, which is deleted after the run.
9. **Pin is not a release.** It needs a source build (reproducibility unproven) or a re-pin to `v1.13.2`. This is an
   operator decision.
