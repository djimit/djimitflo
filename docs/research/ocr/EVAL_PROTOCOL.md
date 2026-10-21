# OCR-P1: paired trial, existing checker vs Alibaba Open Code Review as an additional reviewer

**Status: FROZEN (registration).** This file is registered before any OCR binary exists on a Djimitflo host, before any
item is frozen for the general slice, and before any OCR or checker result for these items is seen.

The sha256 of this file as committed is recorded in `EVAL_PROTOCOL.sha256` and in the PR body. Changes are made only as
dated amendments appended at the end. Nothing above the amendment line is edited.

**Evidence levels.** VENDOR_CLAIM numbers (CAPABILITY_INVENTORY B10) are never used as priors, thresholds or results.
Every result of this trial is OWN_MEASUREMENT. Only the decision in §7 may become a VALIDATED_LESSON.

## 1. Question

**Primary question.** On identical frozen inputs, does OCR, as an additional reviewer next to the existing checker,
find defects that are:
- **independently confirmed**, and
- **missed by the checker**,

at a false-finding load and total cost that are acceptable?

Replacing the checker is **not** the question.

**Constraints of the trial**
- It does not influence any merge decision, PR comment, commit status, checker verdict or loop gate.
- It runs offline in a throwaway container.
- It never touches the prod DB and never runs in `djimitflo-live` (the SEC-F1 runner pattern, `docs/research/eco/SEC-F1_RUN.md`).

## 2. Items: two slices, frozen before any run

### Slice S: security, the SEC-F1 item set (46 items)

**Source**
- `docs/research/eco/sec-f1/manifest.json`, sha256 `29e591e4a75371aa4b81081c0889e57b373e6be2cc72b0db6755c6ef2a897a6f`.
- Protocol: `docs/research/eco/SEC-F1_PROTOCOL.md`, sha256 `e9a9755c…ba38bb`, Amendment 1.
- Composition: 20 `vulnerable`, 20 `benign_fix` and 6 `decoy` items. They come from real upstream GHSA fix commits, and
  the labels come from the advisories.

**Input to both arms**
- The SEC-F1 runner's prepared state (`sec-f1-run.mjs --prepare-only`): a depth-1 checkout of `base_sha` with the item
  patch applied.
- For OCR, the patch is committed as a single head commit with a fixed neutral identity:
  - author `ocr-p1 <ocr-p1@invalid>`;
  - date `2026-01-01T00:00:00Z`;
  - message `item <id>`.
- The head SHA is therefore deterministic and is recorded per item.
- OCR also gets the item's blind `finding` text as `--background`. That is the same task context the checker gets.

**What OCR never sees**
- `variant`, `class`, `ghsa`, `cve`, `cwe`, `upstream_commit` or `source`.
- Any history beyond depth 1.

**Pairing with the checker**
- The SEC-F1 checker results (currently being produced) are used **only** if their `run-meta.json` shows:
  - the same manifest sha256;
  - per-item `patch_sha256` equal to the manifest;
  - the frozen `CHECKER_INSTRUCTIONS` hash `dd101494…`.
- Otherwise the checker arm is re-run with the SEC-F1 runner on the same prepared inputs.

### Slice G: general, the F1 checker set (40 items)

**Composition**
- 20 good items: the merged loop PRs #474 #475 #537 #552 #571 #574 #582 #587 #588 #590 #591 #592 #593 #594 #605 #606
  #610 #611 #612 #616. Each is a single-file, test-only squash commit on `main`, and the base is its parent.
- 20 defective items: the same diffs, weakened by the kind recorded on 2026-10-14:
  - **A, expects removed:** 475, 571, 587, 591, 594, 610, 616.
  - **B, matchers changed to `toBeDefined`:** 474, 552, 582, 590, 593, 606, 612.
  - **C, target import dropped:** 537, 574, 588, 592, 605, 611.

**Re-freeze first (step G0)**
- The 14-10 case files and `mutate.py` are lost (CAPABILITY_INVENTORY A6). The old checker verdicts are therefore
  **context only** and are never paired.
- G0, before any run:
  1. Rebuild the 20 good diffs with `git diff <parent> <squash>`.
  2. Generate the 20 defective variants with a new deterministic script, committed to `docs/research/ocr/f1g/`
     **before** generation. It removes all `expect(` lines for A, rewrites every matcher on the changed lines to
     `.toBeDefined()` for B, and deletes the import of the module under test for C.
  3. Write `docs/research/ocr/f1g/manifest.json` with `id`, `pr`, `kind`, `side`, `base_sha`, `patch_sha256` and
     `defect_lines` (the head-side line ranges that differ from the good variant; empty for good items).
  4. Commit all of it, and record its sha256 in an amendment.

**Both arms run fresh on G**
- **Checker arm:** the prod checker path, as on 14-10. That means prod `buildCheckerPrompt`, the original assignment
  packet and the original maker check logs, run on opencode 1.18.10.
- **OCR arm:** gets the assignment packet text as `--background-file`. It does **not** get the check logs: OCR has no
  evidence channel for them, and on 14-10 the one false accept was anchored on them (VALIDATED_LESSON,
  `f1-rerun-20261014.md`).
- This context difference is part of the comparison, and it is reported.

### Labels and defect locations

- **S:** the label is `variant`. The defect location of a vulnerable item is the head-side line ranges of its patch.
- **G:** the label is `side`. The defect location is `defect_lines`.
- Labels are read only by the scorer, after both arms have finished.

## 3. Arms

| | C: existing checker | O: OCR native |
|---|---|---|
| Path | S: `scripts/sec-f1-run.mjs`. G: the prod checker prompt plus `OpenCodeExecutor` (opencode 1.18.10) | ADAPTER_DESIGN §2.2: native binary, synthetic `HOME`, built env, trusted `--rule` |
| Model | Prod default `ollama/glm-5.2:cloud`, which is the F2 "same" arm. Recorded per item as `effective_model` | Chosen by the operator (§8). Its **family must not be glm, kimi or gemma, and its provider must not be ollama** |
| Settings | Prod timeouts and the 1 M brake | `--effort medium --concurrency 2 --timeout 10 --max-tokens-budget 300000`, English, embedded tools, no MCP |
| Version | opencode 1.18.10 | OCR `375f64cd` built from source, **or** `v1.13.2`, at a binary sha256 recorded in this repo (operator choice, §8) |

**T0 calibration**
- Runs before item 1. It reviews one synthetic two-file change with the pinned binary. This is the only spend outside
  the items, and it is capped at 200 K tokens.
- It records `trusted_rule_sha256` and the `ocr version` string.
- It exercises one PARTIAL path, a deliberately too-large file, to confirm the manifest contract against the real
  binary.
- If any of these deviates from COVERAGE_CONTRACT, the trial stops.

**Order and execution**
- Item order is a seeded shuffle, seed `ocr-p1`, over all 86 items.
- One item runs at a time.
- Arm C and arm O never see each other's output.

## 4. Validity rules and stops

**Invalid runs**
- A run whose independence assessment (`assessOcrIndependence` against arm C's identity) has **any correlated field**
  invalidates the OCR arm. The trial then decides DEFER (invalid).
- **Mock results never count.** This covers any result whose provenance has a provider or model of `mock`, a binary
  sha256 other than the pinned one, or no provenance at all. Such a result is discarded and the item counts as
  missing.

**Missing results**
- Missing results **stay in the denominator** (§6).
- Missing means: INSUFFICIENT_EVIDENCE, FAILED, SKIPPED, a checker `insufficient_evidence` or no verdict, or a discarded
  result.

**Stops**
- **Harness fault:** more than 2 OCR INSUFFICIENT_EVIDENCE results among the first 10 OCR items. Stop, fix, record the
  restart as an amendment, and re-run from scratch.
- **Token cap for the OCR arm:** 26 M total, counting T0 and every item. No item starts once the total is reached. The
  running item's `--max-tokens-budget` is lowered to what remains.
- **Token cap for the arm C re-runs:** 2.5 M on G and 6 M on S. The S cap is the SEC-F1 cap and applies only if S must
  be re-run.
- Unscored items are reported as unscored. The decision is then made with them counted as missing.

## 5. Scoring

### Flags

- **Arm C flags** an item when its verdict is `needs_revision` or `rejected`.
- **Arm O flags** an item when it has at least one finding that:
  - has severity critical, high or medium;
  - is on a file of the item;
  - comes from a run whose outcome is COMPLETE or PARTIAL.
  
  A finding from an INSUFFICIENT_EVIDENCE run never counts. Its input or rules were not the frozen ones.

### Blind adjudication

**What the adjudicator sees**
- The item diff and the flag text: checker notes, or OCR finding contents.
- Not the arm, not the label, and not the other arm's output.
- Flags are pooled and shuffled with seed `ocr-p1-adj`.

**The question**
- For a **defective or vulnerable** item: "does this text identify the defect at the recorded location?"
  - The OCR finding's lines must overlap the defect lines ±3.
  - The checker's notes must name the weakened assertion, the removed expectation, the dropped import, or the
    vulnerable code.
  - Answer: `confirmed`, `refuted` or `undetermined`.
- For a **good, benign or decoy** item: "is this a real defect in the change?"
  - `confirmed` needs concrete evidence: a reproducing test or input, or a code-path citation the adjudicator verifies
    in the checkout.
  - Answer: `confirmed`, `refuted` or `undetermined`.

**Who adjudicates**
- The operator, or a human the operator names. That person is recorded.
- A model adjudicator may be used only as a **secondary**, reported score. It must be of a family outside both arms,
  and it never decides §7.

### Primary metrics

All rates are reported with Wilson 95 % intervals. Paired comparisons use exact two-sided McNemar.

| Metric | Definition |
|---|---|
| **M1: additional confirmed defects** | (a) Defective or vulnerable items with an O flag `confirmed` and no C flag `confirmed`, **plus** (b) good items where O has a `confirmed` real defect that C did not flag. Reported per slice and in total, with McNemar on the defective items (O-only vs C-only discordant pairs) |
| **M2: missed known defects** | Defective or vulnerable items with no O flag `confirmed`. Also: items C caught that O missed. Report only, not a decision input: O is additive |
| **M3: false findings on good changes** | Among the 46 good, benign or decoy items, the share where O has at least one flag that is not `confirmed`. Also: mean OCR findings of any severity per item (the triage load), and the same for C false rejects. Decoys are reported separately |
| **M4: cost** | OCR input, output, cache-read and cache-write tokens per item (median, p90, sum), taken from OCR `summary`. Arm C tokens come from opencode step totals. € equals tokens × the chosen model's price sheet, captured as a file with its sha256 on the run date. For a subscription it is the share of the plan's quota, stated as such and never as €0 |
| **M5: wall time** | Per item (median, p90), as measured by the harness. Arm C is measured the same way |
| **M6: coverage** | The share of O runs per slice that are COMPLETE, and the distribution of outcomes and `unreviewed` reasons |

**Unadjudicated scores** (flag means caught, with no confirmation) are reported for both arms as secondary numbers.

## 6. Missing data

- **On a defective or vulnerable item,** a missing result counts as **not caught** for that arm.
- **On a good item,** a missing result is reported both ways: excluded, and as a false finding (worst case). §7 uses
  the **worst case**.
- Missing results are never imputed from the other arm, from an earlier run, or from VENDOR_CLAIM numbers.

## 7. Decision rule (pre-registered; evaluated in order; the first match wins)

| Outcome | Condition |
|---|---|
| **DEFER (invalid)** | The OCR arm is invalid (§4 independence), **or** T0 failed, **or** fewer than 80 % of O items in either slice are COMPLETE or PARTIAL |
| **EXPAND** | **All of:** (1) M1 total ≥ 3, with ≥ 2 of them on labelled defective or vulnerable items (M1a); (2) M3 worst-case ≤ 20 % of good items (≤ 9/46) **and** mean O findings per good item ≤ 2; (3) M6: COMPLETE on ≥ 90 % of O items; (4) M4: median O tokens per item ≤ 250 K, with the whole trial inside the authorized cap |
| **TARGETED_ADAPT** | M1 total ≥ 1, but EXPAND is not met. This includes the case where M1 ≥ 3 but the false-finding, coverage or cost criteria fail. The next step is limited to the slice, class or path set where the confirmed additional catches fell, under a new protocol |
| **DEFER** | M1 total = 0. Record a negative-evidence entry (`docs/research/negative-evidence/`), and do not re-propose OCR without a new capability claim |

**What the outcomes mean**
- **EXPAND** means OCR runs in **shadow** on a wider scope. For example: every loop change after the checker, through
  the adapter, writing `judgments` rows only.
- **No outcome of this trial enables acting.** Using OCR for any merge, comment, status or gate needs a separate
  operator decision.
- That also needs a runtime-admission ruling on `child_agents: RUNTIME_INTERNAL` (ADAPTER_DESIGN §2.1, BLOCKING for
  productisation).

**Power note, recorded now so it cannot be used as an excuse later**
- On G, arm C missed 1/20 defective items on 14-10 (OWN_MEASUREMENT). M1a headroom on G is therefore about 1.
- The trial can only reach EXPAND through S, or through confirmed new defects on good items.
- An INCONCLUSIVE-looking result is still mapped by the table above. There is no extension without an amendment
  registered before any extra item is run.

## 8. What the real run needs (operator authorization; nothing is assumed)

| Need | Detail |
|---|---|
| **Provider and model for arm O** | It must support native tool calling. Its family must be outside glm, kimi and gemma. Its provider must differ from the checker's (`ollama`). Candidates (none chosen): (a) **Anthropic API**, direct key; (b) **OpenAI API**, direct key; (c) the **LiteLLM gateway** `100.81.133.48:4000` as an OCR custom provider (protocol `openai`). With (c), the upstream model and provider behind the alias must be recorded, or independence is UNDETERMINED. **Ollama Cloud is not a valid arm O provider**: it is correlated with the checker on provider, so the run would be invalid under §4 |
| **Token budget for arm O** | A hard cap of **26 M tokens**: T0 at most 0.2 M, and 86 items at most 300 K each. The expected spend is lower but unmeasured. VENDOR_CLAIM averages of 330-750 K per PR are for larger multi-file PRs and are not used. OCR traffic is input-heavy: the vendor reports about 97 % input. € equals tokens × the chosen model's price on the run date (§5 M4); no price is assumed here |
| **Token budget for arm C** | **≤ 2.5 M** for G on the existing Ollama Cloud subscription (14-10: 1.80 M for 40 items). **≤ 6 M** for S only if the in-progress SEC-F1 results fail the pairing checks in §2 |
| **Binary** | Choose (i) a source build of `375f64cd` (Go 1.26.9, reproducible sha256 shown twice), or (ii) a re-pin to `v1.13.2` with the attestation verified. Either way the sha256 is held in this repo |
| **Host** | A throwaway container from the prod image or a workstation, with no `/data` mount, no DB and no compose network. Egress is limited to GitHub for the SEC-F1 prepare step and to the chosen provider host |
| **Adjudicator** | The operator, or a named human, for an estimated 30-80 flags |
| **Data leaving the host** | Public code only: the SEC-F1 sources are MIT or Apache, and djimitflo is a public repo |

## 9. Outputs

- `docs/research/ocr/OCR-P1_RESULT.md`
- Per item, under the run directory: the OCR `result.json`, the preview JSON, the provenance record and the checker
  result.
- `score.json`: every metric, the decision, and the list of missing and discarded items with reasons.
- Raw OCR session stores are deleted with the ephemeral `HOME`.

---
## Amendments

(none)
