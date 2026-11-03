# OCR coverage contract (v1, `ocr-adapter/v1`)

This is the normative contract for turning an OCR run into a Djimitflo shadow observation. It is implemented by
`packages/server/src/services/ocr-review-adapter.ts` (`computeCoverage`, `evaluateOcrRun`) and tested with fake OCR
outputs in `packages/server/src/__tests__/ocr-review-adapter.test.ts`. The OCR facts are cited at
`alibaba/open-code-review@375f64cd` (OWN_MEASUREMENT: source reading; see CAPABILITY_INVENTORY Part B).

## 1. The denominator is the frozen change, never OCR's selection

**The change**
- A change is `(repo, base_sha, head_sha)`, with `base_sha` an ancestor of `head_sha`. Both SHAs are frozen before the
  run.
- The denominator is **every record** of `git diff --name-status -z --find-renames <base_sha> <head_sha>`, computed by
  Djimitflo (`parseNameStatusZ`).
- Each item carries `path`, `old_path` (renames and copies), `change` (added, modified, deleted, renamed, copied,
  type_changed), `similarity` and `is_test`.

**Rules for diff items**
- **Test files are explicit items.** `is_test` comes from Djimitflo's own classifier, `isTestPath`. OCR's default
  excludes skip every common test pattern, so the trusted rule must `include` them (§3). Otherwise they end up as
  `unreviewed`.
- **Deletions are explicit items.** OCR never reviews them; it excludes them as `deleted`. They count as reviewed only
  if another control covers them.
- **Renames are matched on `(old_path, path)`.** If there is no exact match, the new path is used. OCR also diffs with
  `--find-renames`.
- **An unknown or unparseable diff status** (U, X, a truncated record) is an error, and the result is
  INSUFFICIENT_EVIDENCE. It is never guessed.

**Why OCR's selection is not the denominator**
- OCR's manifest `coverage.selected` contains only files that passed OCR's filter (`internal/agent/selection.go:43-60`).
  Binary files, secret paths, unsupported extensions, default-path tests and vendor files, too-large files, deleted files
  and root `vendor/` / `node_modules/` (`provider_directory`) never appear in it.
- Taking `selected` as the denominator would let a run that reviewed nothing relevant report `complete`.

## 2. Exactly one status per diff item

| Status | When (in this order) | Evidence ref |
|---|---|---|
| `out_of_scope_policy` | The path matches a glob in the **trusted** policy's `out_of_scope`, or OCR `waived` it **and** the trusted policy lists that waiver | `policy_ref` |
| `reviewed` | The item is in OCR manifest `coverage.completed` | OCR `run_id` |
| `validly_reused` | The item is in OCR `coverage.reused` **and** `manifest.parent_run_id` is in the trusted list of OCR runs this adapter recorded for the same frozen input | parent `run_id` |
| `covered_by_control` | OCR did not review it **and** a named existing control supplies `(path, control, evidence_ref)`, for example a checker lease that read the full diff | the control's ref |
| `unreviewed` + reason | Anything else | — |

**Reasons recorded for `unreviewed`:**
- `ocr_excluded:<binary|secret_exclude|user_exclude|unsupported_ext|default_path|provider_directory|deleted|too_large>`
  (taken from `ocr review --preview --format json`)
- `ocr_does_not_review_deletions`
- `not_in_ocr_manifest`
- `ocr_failed:<provider|timeout|cancelled|configuration|input|budget|panic|unknown>`
- `ocr_reuse_unverified`
- `ocr_waiver_not_trusted`
- `ocr_no_terminal_item_state`

**Items the change does not contain**
- An OCR coverage item that is not in the frozen diff makes the whole run INSUFFICIENT_EVIDENCE
  (`ocr_items_outside_frozen_diff`). It means OCR reviewed a different input.

## 3. Include and exclude: what is effective, and in which order

**OCR's behaviour (OWN_MEASUREMENT)**
- Filter gates run in this order:
  1. binary
  2. secret_exclude (cannot be overridden)
  3. user `exclude`
  4. user `include` (a bypass of gates 5 and 6, **not a whitelist**)
  5. unsupported_ext
  6. default_path (tests, generated code, dependency directories)
  7. then too_large and deleted
- Root `provider_directory` prefixes are dropped earlier, at the diff level.
- The user include/exclude comes from the **single highest layer that defines either one**, in the order `--rule` >
  `<repo>/.opencodereview/rule.json` > `~/.opencodereview/rule.json` (`internal/config/rules/system_rules.go:351-369`).
  `--exclude` patterns from the CLI are added on top.
- Rule text uses first match in the order `--rule` > project > global > system (`system_rules.go:447-465`).

**Effective configuration in the trial**
- `--rule docs/research/ocr/trusted-rule.json` (pinned copy, hash recorded) with:
  - `include: ["**/*"]`, so tests and other default-path files are reviewed;
  - `exclude: []`;
  - one catch-all entry, `{path:"**/*", rule:"", merge_system_rule:true}`. That gives the per-file system rule
    unchanged, and it shadows any project or global entry.
- No global layer: the synthetic `HOME` has no `rule.json`.
- No project layer: the adapter deletes `<checkout>/.opencodereview/` before the run.
- No `--exclude` flag.

**What still cannot be reviewed**
- binary
- secret paths
- too_large (the diff is larger than 80 % of `max_tokens`)
- deleted
- root `provider_directory`

These end up `unreviewed` with the OCR reason, unless a trusted `out_of_scope` entry or a control covers them.

## 4. Rules and config come from a trusted copy, never from the change

**Precondition: the trusted hash**
- `trusted_rule_sha256` is OCR's own `manifest.execution.rule_config_sha256` for the trusted rule with no project or
  global layer. It is recorded once by running the pinned binary (the first authorized step).
- That hash covers every rule layer, the system rules and the effective include/exclude (`internal/agent/agent.go:
  1058-1072`).
- If no trusted hash is recorded, the result is INSUFFICIENT_EVIDENCE (`trusted_rule_sha256_not_recorded`).

**Checks on every run**
- If the observed hash differs from the trusted one, the result is INSUFFICIENT_EVIDENCE (`ocr_rules_not_trusted_copy`).
  This catches a project rule file that leaked in, a global `rule.json`, or a different OCR build with different system
  rules.
- A change that touches `.opencodereview/**` (or any extra `protected_paths`) is always flagged
  `review_config_in_change:<path>`.
  - The rule file itself is still an ordinary diff item that gets reviewed.
  - The verdict can still be COMPLETE, but only when the hash proves that the change's rules were not used.
- Config (`~/.opencodereview/config.json`) is generated by the adapter in a synthetic `HOME`. It never carries
  `api_key_cmd` or `mcp_servers`, and telemetry is off. Tools are the embedded defaults (`tools_config: 'embedded'`).

## 5. From an OCR run to an outcome

The checks are applied in this order (`evaluateOcrRun`). The first failing check wins.

1. **INSUFFICIENT_EVIDENCE** if any of these hold:
   - no output or unparseable output (`ocr_no_output`, `ocr_output_not_json`, …);
   - no manifest (`ocr_manifest_missing`), or a manifest schema other than `ocr.run-manifest/v1`;
   - the manifest's `input.resolved_base` or `resolved_head` differs from the frozen SHAs;
   - OCR items outside the frozen diff;
   - no trusted rule hash, or a hash mismatch;
   - Djimitflo ended the process (`terminated_by_adapter:<wall_timeout|token_budget|cancelled>`) or it died from a signal;
   - the frozen diff is unparseable;
   - the exit code is not 0 but `terminal_state` is not `failed` (a contradiction).
2. **FAILED** if `terminal_state = failed`: everything failed, or there is a run failure. The gate is `unknown`. A
   failed run is never read as a negative review.
3. **SKIPPED** if the frozen diff is empty, or if OCR reviewed nothing: zero `reviewed` and zero `validly_reused`. This
   holds even when every item is covered by other controls or by policy. OCR then added nothing.
4. **PARTIAL** if at least one item is `unreviewed`. That includes an OCR budget stop, which shows up as `failed(budget)`
   items under an OCR `partial` with exit 0.
5. **COMPLETE** if nothing is `unreviewed`, at least one item is reviewed by OCR, and every waiver and reuse was checked
   against the trusted policy.

**From outcome to GateStatus (E2, `loop-types.ts:16-21`)**

| Outcome | Gate |
|---|---|
| COMPLETE, no findings | `pass` |
| COMPLETE, one or more findings | `fail` |
| PARTIAL, SKIPPED, FAILED, INSUFFICIENT_EVIDENCE | `unknown` |

- `skipped`, in the E2 sense of "not applicable", is never used. An OCR skip on a non-empty change is missing evidence.
- `accepted` is the literal `false` on every verdict. **Exit 0, empty findings, partial and skipped never map to
  accepted.** In shadow mode even a COMPLETE `pass` changes nothing.
- This mirrors `decideObserved` (`judgment-service.ts:49-58`): an observation with a missing part is "uncertain or
  insufficient evidence", never a default `yes` or `no`.

**Findings**
- Findings are kept on every outcome as shadow observations: path, lines, severity, category, content sha256 and
  `in_diff`.
- Only a COMPLETE run turns them into a gate signal.

## 6. Provenance record (`buildOcrProvenance`)

Every run produces one record with these fields:
- `adapter_version`
- `ocr`: version, source_revision, binary_sha256, `auto_update: 'disabled'`
- `llm`: provider and model, as OCR reported them
- `rules`: policy_ref, trusted_rule_sha256, observed rule_config_sha256, observed runtime_config_sha256
- `toolset`: tools_config and mcp_servers
- `source`: repo, base_sha, head_sha
- `bounds`: concurrency, timeout and token budget
- `outcome`, `gate` and `reasons`
- coverage counts and the findings count
- `tokens`: input, output and total. These are **`null` when OCR did not report them; UNKNOWN is never 0**
- `duration_ms`, `exit_code` and `terminated_by`
- `independence`

## 7. Independence

**How it is assessed**
- `assessOcrIndependence` passes `leaseIdentity` metadata for OCR (model `provider/model`, and a prompt identity of OCR
  version plus template) and for the other reviewer into `ReviewerIndependenceService.assess`
  (`reviewer-independence-service.ts:67-95`).
- A shared model family or provider is **correlated**, which gives FAIL.
- Unknown context, memory, retrieval or oracle hashes give **UNDETERMINED**. That is the honest default; it is not a
  PASS.

**What does not count as independent review**
- OCR's internal `REVIEW_FILTER_TASK` and re-location passes run on OCR's own model. They are self-reflection and are
  never counted as an independent review.

**In the paired trial**
- OCR must not share a model family with the existing checker (glm, kimi, or gemma under F2 v2). A FAIL here
  invalidates the run for the "additional reviewer" question (EVAL_PROTOCOL §4).
