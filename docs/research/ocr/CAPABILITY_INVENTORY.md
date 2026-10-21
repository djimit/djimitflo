# OCR evaluation: capability inventory (Djimitflo and Alibaba Open Code Review)

Date: 2026-10-21. Djimitflo source is `origin/main` at `5a8d1b9c`. OCR source is `alibaba/open-code-review` at
`375f64cd6f67a48a135da83cfcf59c52669a09cb` (2026-10-20, "fix(tool): report an empty code_comment batch instead of
success (#1773)").

The OCR source was shallow-cloned into a scratch directory with git hooks disabled. It was read and then deleted. It was
not built, installed or executed: no npm, no go, no postinstall, no model call.

**Evidence levels used in every OCR evaluation document:**
- **VENDOR_CLAIM** is what OCR or Alibaba states: README, docs, the benchmark page. It is not checked by us.
- **OWN_MEASUREMENT** is something we observed ourselves. In this document that only means reading source code at a
  pinned commit, or a measurement recorded in a Djimitflo doc with its date.
- **VALIDATED_LESSON** is a conclusion that an earlier Djimitflo experiment has already supported. It is cited with its
  source document.

**Two kinds of capacity are kept apart:**
- **Code found** means the mechanism exists in the repo.
- **Operational** means a repo document, runbook or report shows it running in prod. Prod read-only queries were not
  available for this task, so operational status is **UNKNOWN** unless a repo document shows it. UNKNOWN is never 0.

---

## Part A: Djimitflo (what OCR would sit next to)

| # | Capability | Code found (file:line) | Operational status (repo evidence) |
|---|---|---|---|
| A1 | **GitHub PR review, phase 1** | `packages/server/src/services/github-pr-review-service.ts` | **Phase 1: running.** `docs/research/intelligence-metrics/AGENT_SWARM_EVALUATION.md:16` reports 583/578 manual PR-review maker/checker runs. Code comments :183 and :191 cite prod counts from 25-09 and 27-09. **Phase 2: UNKNOWN.** No doc names a prod value for `GITHUB_PR_REVIEW_RUNTIME`. |
| A2 | **`LoopService.executeChecker`** | `loop-service.ts:1360` → `loop-worker-executor-service.ts:283` | **Live.** `AGENT_SWARM_EVALUATION.md:13-14` reports checker × opencode 71 runs and security_checker × opencode 72. `docs/research/ace/CURRENT_STATE.md:24` says "F1 checker AUC 0.875 … IMPLEMENTED". |
| A3 | **Reviewer independence** | `reviewer-independence-service.ts` | **Observation only. No gate reads it.** `docs/research/cognitive-runtime/BASELINE.md:38`: "DECLARED_ONLY; correlation MISSING". Code comment :36: before identity stamping, 21 of 960 leases carried identity. Coverage after stamping: UNKNOWN. |
| A4 | **Loop verification** | `loop-verification-service.ts` | **Live.** `CURRENT_STATE.md:24`. |
| A5 | **Checker-family experiment F2** | `services/checker-family.ts` | `CHECKER_FAMILY_RANDOMISE=on` per `docs/research/eco/CODEX_REPORT.md:30`. Collecting: `PHASE0_AUDIT.md:103` reports 3/2 and `EVOLUTION_VALIDATION.md:17` reports n = 1. Whether **v2 is live: UNKNOWN.** |
| A6 | **F1 checker set** | Not in the repo. | See the F1 subsection below. |
| A7 | **SEC-F1** | `docs/research/eco/sec-f1/` | Items and harness are in the repo. **No result in the repo:** `SEC-F1_RESULT.md` does not exist. The checker run was in progress per the operator, so its results are UNKNOWN here. |
| A8 | **E2 observation validity** | Two definitions | Live in verification (A4). |
| A9 | **Finding and knowledge registration** | Three writers | **`policy_violations`: UNKNOWN.** `INTELLIGENCE_BASELINE.md:39` shows "0 rows, never written", but that predates the writer. **Outcome attribution: live** since 2026-10-08 (`OUTCOME_ATTRIBUTION_DESIGN.md:4`). **Finding-fix lane: UNKNOWN.** The runbook (`docs/runbooks/self-improvement-loop-operations.md:150`) recommends shadow. |
| A10 | **Runtime admission** | `execution/runtime-admission.ts` | **Live.** `reports/runtime-admission-readiness.md:3-10` was measured against prod on 2026-10-05. Also `CURRENT_STATE.md:24`. |
| A11 | **Shipped-code scan** | `services/shipped-code-scan.ts` | **Shadow, live.** `CODEX_REPORT.md:33` and `CURRENT_STATE.md:19` both say "4 runtimes scanned daily, PARTIAL — evidence only". |
| A12 | **opencode executor: budgets and timeouts** | `execution/executors/opencode-executor.ts` | **Live.** The 1 M brake is in prod per `self-improvement-loop-operations.md:64`. Brake kills are recorded in `docs/research/di-001/REVIEWER_NO_VERDICT.md:34`. |
| A13 | **Where reviewer provenance lands** | Several stores | Live as the stores of A2. |

**A1 detail (GitHub PR review)**
- Trigger: the `pull_request` webhook, actions opened/synchronize/reopened (`routes/github-webhooks.ts:25-26`).
- Phase 1 (default) is a heuristic stub with no LLM:
  - `computeVerdict` (:300) returns `needs_revision` when the PR has more than 40 files, more than 1500 lines, or a path
    matching `/\.env|secret|credential/i` (:37-39).
  - The comment reads "⚠️ Needs a closer look before merge." (:319). The footer says "Phase 1 automated stub — full
    checker review not yet enabled. This does not merge or block merging on its own." (:333).
  - It posts with `gh pr comment` (:351). It then calls the **Commit Status API**, `gh api
    repos/{o}/{r}/statuses/{sha}` (:371), with context `djimitflo-review` (`loop-auto-merge-state.ts:28`). The
    description is "Needs a closer look" for pending (:368).
  - The Checks API is not used because a PAT gets a 403 (:358-364).
  - `loop-auto-merge.ts:67` excludes this context from the independent statuses. It can hold a PR but never makes it
    green.
- Phase 2 is an LLM checker. It is off unless `GITHUB_PR_REVIEW_RUNTIME` is set (:197, :40). It calls
  `executeChecker` with a 480 s timeout (:41, :208).

**A2 detail (`executeChecker`)**
- It needs a prepared checker lease linked to a completed maker.
- It refuses the `manual` runtime and needs a runtime contract that is ok (:302-332).
- It creates its own worktree (:334-348).
- The prompt comes from `buildCheckerPrompt` (`loop-service.ts:2499`).
- The timeout is clamped to 1-600 s, default 120 s (:356). The daemon reviewer default is 300 s
  (`loop-daemon.ts:86-89`).
- Verdicts are `CheckerVerdictInput` (`loop-types.ts:216-226`): accepted, needs_revision, rejected or
  insufficient_evidence.
- A non-zero exit or a timeout gives insufficient_evidence (:375).
- A dirty worktree is a `reviewer_read_only` policy violation (:382-386).
- Gates `<role>_runtime_exit_zero`, `<role>_verdict` and `<role>_read_only_contract` are written at :403-407.

**A3 detail (reviewer independence)**
- `assess(maker, checker)` (:67) compares 7 dimensions: model family, provider, prompt, context, memory, retrieval and
  oracle.
- The state is FAIL if any dimension is correlated. It is UNDETERMINED if any dimension is unknown, or if either side is
  mock/manual (:81-84). Same-model self-reflection is therefore FAIL.
- `leaseIdentity()` (:41-49) is stamped at dispatch (`loop-worker-executor-service.ts:555-556`).
- API: `GET /api/swarms/intelligence/reviewer-independence` (`routes/swarm-intel.ts:223`).

**A4 detail (loop verification)**
- `verifyLoopRun` computes 11 gates (:88-157).
- Any `fail` or `unknown` gives `blocked`. The `block_reason` is `insufficient_evidence` when gates are unknown
  (:183-200).
- `reviewEvidence` (:294-318) needs exit 0, no timeout, an accepted runtime verdict, a passed read-only check, and the
  stdout file still present. A missing stdout file gives `unknown`.

**A5 detail (F2)**
- Env vars: `CHECKER_FAMILY_RANDOMISE` (off), `CHECKER_CROSS_MODEL` (default `ollama/kimi-k3:cloud`),
  `CHECKER_FAMILY_TARGET_PER_ARM` (93) and `CHECKER_FAMILY_VERSION` (v1). These are read at :32-51.
- v1 was closed on 2026-10-17. v2 uses cross model `ollama/gemma4:31b:cloud`
  (`docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md:74-78`, :150-156).

**A8 detail (E2 observation validity)**
- `GateStatus = 'pass'|'fail'|'unknown'|'skipped'` (`loop-types.ts:16-21`). `unknown` means insufficient evidence and
  still blocks. `skipped` means not applicable.
- `decideObserved` (`judgment-service.ts:49-58`) returns `uncertain` / `insufficient_evidence` whenever a question has no
  valid answer.
- A different `GateStatus = 'PASS'|'FAIL'|'NOT_PROVEN'` exists in `runtime-admission.ts:11`. It has the same name and a
  different meaning.

**A9 detail (registration writers)**
- `policy_violations` (`database/migrate.ts:189-206`) has a shadow writer `recordPolicyViolation`
  (`policy-violations.ts:36-46`, `POLICY_VIOLATION_LOG=shadow`).
- `judgments` (`migrate.ts:1399-1405`, plus `provenance_json`) is written by `insertJudgmentRow`
  (`judgment-service.ts:66`). Modes are off, shadow or enforce per `TYPESAFE_<ID>_MODE`.
- Outcome attribution (`outcome-attribution.ts`, `OUTCOME_ATTRIBUTION_ENABLED`) writes `judgments` rows with
  `mode='annotation'`.
- The finding-fix lane (`finding-fix-source.ts:26`, `FINDING_FIX_LANE`) uses ESLint pack v1.

**A10 detail (runtime admission)**
- `checkAdmission()` runs before every engine dispatch (`execution-engine.ts:319-320, 840-861`). An unknown runtime is
  denied.
- `decide()` REJECTs in four cases: a critical gate (licensing, reproducibility, supply_chain) is FAIL, the assessment is
  self-attested, authority is held by RUNTIME/SHARED, or capability_gap is NONE.
- Any NOT_PROVEN gives HOLD. `child_agents: RUNTIME_INTERNAL` also gives HOLD.
- The ledger records opencode, atomic, codex and others as `LEGACY_ADMITTED` until 2026-12-31. openhuman is the REJECT
  negative control. One of openhuman's reasons is "npm postinstall downloads a binary whose checksum comes from the same
  origin" (:198).

**A11 detail (shipped-code scan)**
- It reads installed runtime packages without running them: lifecycle scripts, bins, file hashes, and AST findings for
  endpoints, eval and env-token reads.
- Its targets are claude, codex, opencode-ai and atomic (:375-383).

**A12 detail (opencode executor)**
- `OPENCODE_EXECUTION_TIMEOUT_MS` defaults to 600 000 (:134).
- The `OPENCODE_MAX_RUN_TOKENS` brake is set from step tokens (:114-117, :184-193).
- Global concurrency `RUNTIME_MAX_CONCURRENCY` defaults to 4 (`concurrency-semaphore.ts`).
- The env allowlist `buildExecutorEnv` (`executors/executor-env.ts:6-33`) passes `HOME` and `ANTHROPIC_API_KEY`, among
  others.

**A13 detail (provenance stores)**
- `worker_leases.metadata` holds the verdict, runtime_usage tokens, exit status, timeouts and identity (model_id,
  provider, model_family, prompt_hash), written at `loop-worker-executor-service.ts:390-401, 555`.
- Also: `swarm_runner_manifests`, `loop_events`, `judgments.provenance_json` (`judgment-provenance.ts:18-32`) and
  `llm_model_calls` (makers only, no checker rows).
- Reviewer leases have **no duration field**; it has to be derived from started_at and completed_at.

### The F1 checker set (A6)

**What was measured (OWN_MEASUREMENT, recorded in Djimitflo docs)**
- 20 merged loop PRs (good) plus 20 weakened variants (defective):
  - A: expects removed (7)
  - B: matchers changed to `toBeDefined` (7)
  - C: target import dropped (6)
- All 20 good diffs are **single-file, test-only diffs** (`docs/research/eco/SEC-F1_PROTOCOL.md:18-25`).
- 09-10 results: AUC 0.875, good accepted 18/20, defective accepted 3/20 (`INTELLIGENCE_SCORECARD.md:30-31`,
  `INTELLIGENCE_BASELINE.md:104`).
- A re-run on 14-10, on the post-#716 prompt, gave:

  | arm | good accepted | defective accepted | AUC | tokens |
  |---|---|---|---|---|
  | `ollama/glm-5.2:cloud` | 19/20 | 1/20 | 0.95 | 1.80 M |
  | `ollama/kimi-k3:cloud` | 19/20 | 1/20 | – | 2.35 M |

  The only false accept in both arms was 606-defective. Source: session scratch `f1-rerun-20261014.json`, sha256
  `0574660d…a409a7c9`. It is not in the repo.

**What survives (OWN_MEASUREMENT, 2026-10-21)**
- The F1 harness, `mutate.py` and the case files are **not in the repo**, and the scratch copies are gone: `f1r/cases/*`
  is empty.
- The 14-10 notes say 17 of the 20 defective files were already the 09-10 files, and the other 3 were regenerated.
- **So the F1 defective variants cannot be reproduced byte-identically.** The good diffs can be rebuilt
  deterministically from the 20 merge commits.
- Consequence: a paired trial on identical frozen inputs needs a **fresh checker run** on a newly frozen F1 set. Old
  checker verdicts are context only (see EVAL_PROTOCOL §2).

---

## Part B: Alibaba Open Code Review at `375f64cd`

All citations in this part are OCR source paths at the pinned commit.

### B1. What it is (OWN_MEASUREMENT: source reading)

**Language and packaging**
- A Go CLI: module `github.com/alibaba/open-code-review`, `go 1.26.9` (`go.mod`), binary `opencodereview` / `ocr`.
- It ships as an npm wrapper, `@alibaba-group/open-code-review`. Its `postinstall` runs `node scripts/install.js`
  (`package.json`).
  - The installer downloads `opencodereview-{os}-{arch}` from the GitHub release.
  - It checks the binary against `sha256sum.txt` **from the same release** (`package.json` `ocrConfig`,
    `scripts/install.js:194-240`). That is a same-origin checksum.
  - Optional per-platform npm packages can supply the binary instead.
- Other distribution channels:
  - GitHub Action (`action.yml`)
  - IDE extensions (`extensions/vscode`, `extensions/idea`)
  - Agent plugins (`plugins/open-code-review/*`)
  - An experimental ACP adapter: "experimental and currently unstable … only for local compilation from source"
    (`acp/README.md:5-10`).

**Licence**
- Apache-2.0 (`LICENSE`; `package.json` `license`; SPDX headers in sources). It is compatible with Djimitflo's MIT.
- Not checked: the licences of the transitive Go modules. See B9.

**Version**
- The pinned commit is **not a release**. The newest tag on 2026-10-21 is `v1.13.2` → `55450a95` (via `git ls-remote`).
  There are 299 tag refs.
- Pinning to the requested commit therefore means **building from source**. Using a published binary means **re-pinning
  to a release tag**. Either is an operator decision.
- Release CI uses two provenance mechanisms:
  - It attests build provenance for the binaries and `sha256sum.txt` (`.github/workflows/release.yml:242-247`,
    `actions/attest-build-provenance`).
  - It publishes npm with `--provenance` (:315, :336).
- Only the latest release gets security fixes (`.github/SECURITY.md:5-10`).

**Commands**
- `review`: workspace, range (`--from/--to`, computed as `merge-base(from,to)..to`) or commit (`-c`).
- `scan`: whole files.
- `rules check`.
- `config`, `llm test|providers|models`, `auth` (ChatGPT sign-in preview).
- `session list|show|comments|compare|export|rm`.
- `viewer` (local HTTP, `localhost:5483`).
- `delegate preview|rule`.
- Source: `pages/src/content/docs/en/cli-reference.md:67-88`.

**Review pipeline (native mode)**
1. **Deterministic file selection.** Six gates: binary, secret_exclude, user_exclude, user_include, unsupported_ext,
   default_path. Then too_large and deleted (`internal/agent/selection.go:43-60`; docs `review-rules.md:142-171`).
2. **File grouping.** One "cheap metadata-only" LLM call (`cli-reference.md:806-808`).
3. **Plan.** This phase is skipped below 50/100 changed lines (:801-804).
4. **Main review rounds.** Rounds per effort: low = 1, medium = 2 (default), high = 3 (:126-127).
5. **LLM post-steps.** A `REVIEW_FILTER_TASK` pass (disabled by `--no-filter`, :117), comment re-location, and memory
   compression.
- Prompts are embedded: `internal/config/template/prompts/*.md` (12 files) and `task_template.json`.
- Agent tools:
  - `task_done`
  - `code_comment`
  - `code_search` (`git grep`)
  - `file_read` (in range/commit mode, `git show <ref>:<path>`: `internal/tool/filereader.go:70, 118-122`)
  - `file_read_diff`
  - `file_find`
  - plus any MCP server tools from the user config (`internal/config/toolsconfig/tools.json`; config key
    `mcp_servers`).
- The built-in tools are read-only.
- Requires Git ≥ 2.41 (README "Prerequisites").

**Delegation mode**
- `ocr delegate preview` and `ocr delegate rule` run **no LLM**. They output the file list, the exclusions and the
  resolved rule text, grouped by rule (`cmd/opencodereview/delegate_cmd.go:37-72`).
- The host agent (Claude Code, Codex, …) then does the whole review with its own model, following a skill checklist.
  The checklist includes self-reported "reviewed/skipped" and `coverage_rate`
  (`skills/open-code-review-delegate/SKILL.md`, Steps 1-6).
- **Delegation is a different reviewer.** The model, the prompts and the coverage accounting all belong to the host
  agent. No native-mode number applies to it.

**Calling LLMs**
- Built-in providers (`configuration.md:45-71`):
  - anthropic, bedrock (SigV4), openai, openai-responses
  - chatgpt (OAuth sign-in), openrouter, gemini
  - dashscope, dashscope-tokenplan, volcengine, deepseek
  - tencent-tokenhub, hy-tokenplan, iflytek
  - kimi, kimi-global, z-ai, mimo, minimax, minimax-cn
  - baidu-qianfan, siliconflow, siliconflow-cn, novita, xai
- Custom providers take `url` and a protocol: anthropic, openai, openai-responses or anthropic-bedrock. Examples include
  Ollama and a LiteLLM gateway (:95-113, :164-227).
- The model must support native tool calling (:224-227).
- SDKs: `anthropic-sdk-go v1.63.1`, `openai-go/v3 v3.51.0`, `aws-sdk-go-v2` (`go.mod`).
- Retries: up to 5 with backoff on retryable errors (`configuration.md:266-272`).

**Credential discovery**
- Without `--provider`, OCR tries these sources in order (`cli-reference.md:152-159`; `internal/llm/resolver.go`):
  1. Saved config.
  2. Complete `OCR_LLM_*` env.
  3. The Claude Code env, `ANTHROPIC_*` (:735-755).
  4. **Shell rc files.** It parses `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` and `~/.profile` for
     `export ANTHROPIC_*` (:758-841).
- `api_key_cmd` / `auth_token_cmd` **run a shell command taken from config** (`configuration.md:280-326`).
- So `HOME` and the env must be fully controlled by the caller.

**Config and rule files, with precedence**
- Config: `~/.opencodereview/config.json`, written with mode 0600 (`configuration.md:7-12, 324-326`).
- Rule text uses four layers. The first matching `path` entry wins (`internal/config/rules/system_rules.go:288-349`):
  1. `--rule <file>`
  2. **`<repo>/.opencodereview/rule.json` (project)**
  3. `~/.opencodereview/rule.json` (global)
  4. Embedded `system_rules.json`
- **The project layer is loaded even when `--rule` is given** (:319-326). Its rule entries may point at `.md`/`.txt`
  files inside the repo, which are inlined; reads are confined to the repo (:575-640).
- `merge_system_rule: true` appends the user rule to the per-file system rule (`review-rules.md:62-122`).
- `include`/`exclude` come from **the single highest layer that defines any include or exclude**, in the order
  custom > project > global. They are **not merged across layers** (`buildFileFilter`, `system_rules.go:351-369`).
  - `--exclude` on the CLI is merged with that layer (`cli-reference.md:124`).
  - `include` is a **bypass, not a whitelist**. It skips `unsupported_ext` and `default_path`, but not `binary` or
    `secret_exclude` (`review-rules.md:49-58, 140-171`).
  - Patterns are matched case-insensitively with doublestar (`review-rules.md:124-138`).
- Default excludes (`internal/config/allowlist/default_exclude_patterns.json`; `review-rules.md:191-281`):
  - **All common test-file patterns**: `**/*.test.{js,jsx,ts,tsx}`, `**/*_test.go`, `**/__tests__/**`, `**/test_*.py`,
    `**/testdata/**`, `**/fixtures/**`, …
  - Generated code.
  - Dependency and build directories.
- Root-level `vendor/`, `node_modules/`, `.git/`, … are removed before selection and reported as `provider_directory`.
  An `include` cannot bring them back (`internal/diff/git.go:27-40`).
- Secret paths are never reviewed: `.env*`, `.ssh/**`, `.npmrc`, … (`review-rules.md:173-189`).
- **Deleted files are excluded** as `deleted` (:169-170).
- A file whose diff is larger than 80 % of `max_tokens` is excluded as `too_large` (:166-168, `cli-reference.md:795-797`).
- `rule_config_sha256` in the run manifest hashes every rule layer plus the effective include/exclude
  (`internal/agent/agent.go:1058-1072`; `system_rules.go:466-488`). A leaked project rule file therefore changes it.

**Output**
- `--format text|json|sarif` (`cli-reference.md:119`).
- The JSON document (`cmd/opencodereview/output.go:337-356`) holds:
  - `status` and `llm{provider,model}`
  - `summary`: files_reviewed, comments, input/output/total tokens, cache tokens, elapsed, budget_exceeded
  - `tool_calls`
  - `comments[]`: path, content, start/end line, existing/suggestion code, thinking, `category` (bug, security,
    performance, maintainability, test, style, documentation, other) and `severity` (critical, high, medium, low)
    (`internal/model/review.go:7-21`)
  - `warnings`, `session_id`, `resume`
  - `manifest`
  - `retry_report`
- The manifest is `ocr.run-manifest/v1` (`internal/session/manifest.go:20-23, 228-286`). It has:
  - Five disjoint coverage sets: `selected` (the denominator) = completed ∪ reused ∪ failed ∪ waived.
  - Typed item failure classes: provider, timeout, cancelled, configuration, input, budget, panic, unknown.
  - `run_failure`.
  - `input`: resolved base/head SHAs.
  - `execution`: ocr_version, provider, model, rule_config_sha256, runtime_config_sha256.
- **The manifest's `selected` set is only what survived OCR's filter.** Excluded tests, deletions, binaries and
  too-large files are not in it. They show up only in `--preview` output (`internal/model/preview.go:11-46`), which has
  no `old_path`.

**Terminal state and exit codes**
- `terminal_state` (`manifest.go:937-958`):
  - `skipped` if nothing was selected
  - `complete` if nothing failed
  - `failed` if everything failed, or if `run_failure` is set
  - otherwise `partial`
- **Exit code 0 for complete, partial and skipped.** Non-zero only for a fatal error or `failed`
  (`cmd/opencodereview/review_cmd.go:326-351`; `cli-reference.md:351-360`).
- Running out of the token budget is a "controlled truncation": the remaining items get `failed(budget)`, the state is
  `partial`, and the exit code is 0 (`output.go:423-431`).
- `waived` exists in the schema, but no non-test caller of `MarkWaived` exists at this commit (grep).

**Bounds**
- `--timeout`: per-subtask budget in minutes, default 15, multiplied by the number of effort rounds.
- Per-request HTTP timeout: 300 s, set by `OCR_LLM_TIMEOUT` / `timeout_sec`.
- `--concurrency`: default 8.
- `--max-tokens`: per-subtask prompt cap, default 200 000.
- `MAX_COMPLETION_TOKENS`: 16 384.
- `--max-tokens-budget`: whole-run cap, default unlimited.
- `--max-tools`: default 100.
- `--max-git-procs`: default 16.
- Sources: `cli-reference.md:110-135`, `configuration.md:229-373`.

**Network egress (native review)**
- The configured LLM endpoint.
- Configured MCP servers.
- For the `chatgpt` provider, `auth.openai.com` and `api.openai.com`.
- Tokenizer BPE files are **embedded** (`internal/llm/embedded_loader.go:16, 44-47`), so tiktoken does not fetch them.
- `ocr viewer` listens on localhost.
- The **npm launcher and installer** also reach `registry.npmjs.org` and `github.com`.

**Auto-update**
- It lives **in the npm launcher only** (`bin/ocr.js:89-110`). Unless `OCR_NO_UPDATE` is set, every launch past an
  18-minute cooldown (`OCR_UPDATE_INTERVAL`) spawns a **detached** `scripts/update.js`.
- That script queries the npm registry and, if a newer version exists, **runs `npm i -g <pkg>@<latest>` silently**
  (`scripts/update.js:129-170`). That would also re-run `postinstall`.
- The Go binary has no self-update code (no registry or release URL in non-test Go sources).
- **Mitigation:** run the native binary directly, never through `bin/ocr.js`. Set `OCR_NO_UPDATE=1` anyway.

**Telemetry**
- OpenTelemetry, **off by default**. It is enabled by `OCR_ENABLE_TELEMETRY=1` or config `telemetry.enabled`.
- The exporter is console, or OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Prompt and response content logging is
  off unless `OCR_CONTENT_LOGGING=1` (`internal/telemetry/config.go:14-61, 113+`).
- There is no vendor phone-home in the Go sources (OWN_MEASUREMENT: URL grep).

**Local state**
- `~/.opencodereview/` holds config.json, rule.json, `sessions/`, `last-update-check`, `update.lock` and
  `update-available`.
- Sessions persist reviewed source excerpts. `session export` embeds them (`cli-reference.md:206-209, 501-502`).

### B9. Supply chain (OWN_MEASUREMENT, partial)

**Dependencies**
- 26 direct Go modules (`go.mod`), among them:
  - anthropic-sdk-go
  - openai-go
  - aws-sdk-go-v2/config
  - modelcontextprotocol/go-sdk v1.7.0
  - bubbletea/lipgloss TUI
  - OpenTelemetry 1.45 (OTLP gRPC and HTTP exporters)
  - tiktoken-go
  - doublestar
  - cobra
- About 60 indirect modules, including grpc and protobuf. `go.sum` pins hashes.

**Not checked**
- Transitive licences.
- Advisories.
- Reproducibility of a source build (`go build` at the pin was not run).
- The release attestation of `v1.13.2`.
- These are runtime-admission inputs that are still owed (ADAPTER_DESIGN §4).

**Risk**
- The npm path has the same pattern runtime admission already records as a supply-chain FAIL for openhuman: a
  postinstall download plus a same-origin checksum (`runtime-admission.ts:198`).
- Djimitflo must therefore hold the binary sha256 in its own repo (the atomic precedent,
  `runtime-admission.ts:165-166`) and must never install through npm.

### B10. Claims (all VENDOR_CLAIM; none checked)

**Origin and adoption**
- "Alibaba Group's internal official AI code review assistant … two years … tens of thousands of developers and
  identified millions of code defects" (`README.md:45`).

**AACR-Bench**
- 50 repos, 200 real PRs, 10 languages, 1 505 annotated issues (`README.md:57`;
  `huggingface.co/datasets/Alibaba-Aone/aacr-bench`).
- Selected rows from `pages/src/components/BenchmarkSection.tsx:43-56`:

  | Model | Tool | F1 | Precision | Recall | Avg tokens |
  |---|---|---|---|---|---|
  | Claude-4.6-Opus | OCR v1.3.1 | 25.1 % | 33.9 % | 20.0 % | 385 K |
  | Qwen3.8-Max | OCR v1.8.7 | 23.0 % | 33.9 % | 17.4 % | 334 K |
  | GPT-5.5 | OCR v1.3.1 | 21.0 % | 32.1 % | 15.5 % | 422 K |
  | Claude-4.8-Opus | OCR v1.3.1 | 17.9 % | 37.8 % | 11.7 % | 352 K |
  | Claude-4.6-Opus | Claude Code v2.1.169 | 11.57 % | 7.23 % | 28.9 % | 5.66 M |

**Efficiency and trade-off**
- "~1/9 of the tokens", and lower recall than general-purpose agents "a deliberate trade-off" (`README.md:55`).

**Reading of the claims (not evidence)**
- The numbers come from OCR versions v1.3.1 and v1.8.7, not the pinned commit.
- They are averages over multi-file PRs in 10 languages, measured by the vendor.
- Even at face value, about two in three OCR findings are not matched to ground truth (precision of about 32-38 %), and
  recall is about 12-20 %.
- None of this says anything about delegation mode, our item sets, or our models.

**Badges**
- OpenSSF Best Practices "Gold" badge (README).

### B11. What this means for Djimitflo (VALIDATED_LESSON where noted)

**Inputs to the design**
- **OCR's exit code and `status` cannot be gate evidence.** Exit 0 covers partial and skipped. This is E2: no valid
  observation is not a negative observation (`loop-types.ts:16-21`).
- **OCR's coverage denominator is not the change.**
  - Every F1 good item is a single test-file diff, so **with default rules OCR would skip every F1 item** (`skipped`,
    exit 0). The general slice only makes sense with a trusted rule that `include`s tests.
  - Deletions are never reviewed.
- **The reviewed change can steer OCR.**
  - A committed `.opencodereview/rule.json` controls the rule text and the include/exclude, even next to `--rule`.
  - It can exclude files from review.
  - It is recorded in `rule_config_sha256`, which the adapter checks.
- **Ambient credentials and an auto-updating launcher** mean the process must run with a synthetic `HOME`, a
  constructed env (not `buildExecutorEnv`, which passes `HOME` and `ANTHROPIC_API_KEY`), and the native binary.
- **Lessons the prod checker already taught:**
  - The F1 06-10 false accept shows a reviewer anchoring on inlined check output (`f1-rerun-20261014.md`). The OCR arm
    gets no check output, so the two arms differ in context by design. EVAL_PROTOCOL §3 records this.
  - Prod checker AUC on F1 is already 0.95 with 1/20 false accepts (OWN_MEASUREMENT 14-10). **On F1 the headroom for
    "additional confirmed defects" is at most 1 defective item.** SEC-F1 is the slice that can show value.
