# GLD-001 v1: pre-registration — GLiDE-0.4B against jev on outcome-labelled prescreen states (offline replay)

**Status:** frozen. This file is committed on its own, before the replay script exists on this branch. Its sha256 is
recorded in the next commit (`PREREG.sha256`). Any later change is a protocol deviation, listed in `RESULTS.md`
§Deviations with a reason; it never silently redefines a result.

**Operator directive:** "bereid de GLiDE-proef voor" (2026-11-24). This is an offline study. It changes no backend, no
flag and no decision: jev stays the only System One backend for DjimitFlo decisions (operator, 2026-09-30 and 2026-10-26),
and NE-001 binds every System One model (never approval, promotion, code, risk or fitness).

## 0. Sources and what is already known

| Source | Pin | How it was read |
| --- | --- | --- |
| HF `fastino/GLiDE-0.4B` | `16fb9d63cc34d1b4b5a1fb7cbf2d9d4a3dd5ad71` (2026-11-20) | HF API metadata; `LICENSE`, `NOTICE`, `README.md`, `requirements.txt`, `config.json` read; `glide/*.py` searched by pattern (imports, network, exec, deserialisation), **not reviewed line by line**; no weights downloaded, nothing run |
| arXiv:2611.26509 | v1 | abstract and model card claims only (vendor claims, not reproduced) |

Weights (LFS sha256): `model-00001-of-00001.safetensors` 789 581 344 bytes
`4540aa6d168fd15b06f7d6a61c34dd45523b5a0a1a72f98f1b2a81cf60774f34`; `readout.safetensors` 522 320 bytes
`0cb6da049081b05dc60dcf0c9f95dc4309c8849ab921f61f67f4658172b57f2a`.

- **Licence:** Fastino Community License (not OSI). Evaluation, testing, benchmarking and research are outside its
  "Production" definition, so this study needs no agreement. Production use is a separate operator decision (attribution
  clause 4; clause 2 above 10 M USD annual revenue; derivative works stay under the same licence).
- **Interface:** the bundled server speaks `POST /v1/systemone` with `state` + typed `questions` and returns `noul` per
  question: the same wire shape `typesafe-client.ts` uses. No key is needed locally. Its default bind is `0.0.0.0`.
- **Hardware (vendor):** validated only on an NVIDIA RTX PRO 6000 Blackwell with CUDA 13.0 wheels and `torch==2.14.0`.
  Whether it runs on the operator's hardware is unknown until tried.
- **Context:** 7 999 tokens per question prompt; longer prompts keep the first 1 024 tokens and the end.
- **Prior evidence:** NE-005 (Clef Flash, 2026-10-03, n = 99, 17 verified): AUC jev 0.779 / Clef 0.758, both Brier worse
  than the per-source base rate; verdict REJECT, "equivalent, not better". Its reopen condition asks for a pre-registered
  comparison on newer labelled data. NE-001: the prescreen cascade (routing on jev confidence) is REJECTED; this study
  does not test routing.
- **Not blind to the labels:** on 2026-11-24 the label counts were read from production (read-only): 295 resolved proposals
  created on or after 2026-10-03 carry a non-error jev `proposal_prescreen` row whose `state_hash` matches the proposal
  text as it is now; 166 ended verified or applied (gap_analysis 277 / 166, feedback 18 / 0). All rows are `jev-1.13.0`.
  No GLiDE output of any kind had been seen when this file was frozen.
- `JEV_CHALLENGER_MODEL` is not used: it is the running JEV-114 experiment (stop_by 2027-01-14) and reuses the jev base URL.

## 1. Question and hypothesis

Does GLiDE-0.4B, given the identical state and the identical four `proposal_prescreen` questions, forecast "this proposal
ends verified" better than jev-1.13.0 did?

- **H1:** AUC(GLiDE) − AUC(jev) > 0 on the cases of §2, with the 95 % interval excluding zero.

## 2. Cases

From a **copy** of the production database (never the live file, never inside the production container):

- `self_improvements` created on or after `2026-10-03T00:00:00.000Z` with status in `forecast-scoring.RESOLVED`
  (`infra_failed` is not a resolution);
- joined to the **earliest** non-error `proposal_prescreen` row of that proposal (model `jev-*`, no `@` challenger rows);
- kept only when sha256 of `{"proposal":{type,title,description,rationale}}` (first 16 hex) equals the row's `state_hash`,
  so both models read byte-identical state.

Outcome: 1 for `verified` / `applied`, 0 otherwise. The database copy is taken once; its sha256 and the case count go in
`RESULTS.md`. Minimum: **200 cases scored by both models**, with at least 30 of each outcome; below that the verdict is
INSUFFICIENT_EVIDENCE.

## 3. Procedure

`packages/server/src/scripts/system-one-replay.ts --db <copy> --url <challenger>`: one request per case, sequential, the
four questions of `judgments/proposal-prescreen.ts` unchanged, state unchanged, no retries beyond one. A failed or
malformed answer is an error: counted, never scored, never imputed. The script refuses a `--url` whose host is not
loopback or a private / tailnet address: proposal text does not leave the operator's hosts. The operator installs and
starts the model server; no agent installs or runs third-party code on a host.

## 4. Measures

Forecast p = `forecastOf('proposal_prescreen', answers)` (product of the `verifiable`, `concrete`, `names_file` Nouls), the
same function `forecast-scoring.ts` applies to jev.

- **Primary:** ΔAUC = AUC(GLiDE) − AUC(jev) on the cases both scored; paired bootstrap over cases, 2 000 resamples,
  seed 1, percentile 95 % interval (a resample with one outcome class is redrawn).
- **Secondary (reported, never decisive):** Brier of each model and of the per-source base rate, and skill against it;
  ΔAUC within `gap_analysis` alone (source is a confounder: every `feedback` case is a negative); `names_file` accuracy
  (Noul ≥ 0.5) against the deterministic `PATH_RE` label; agreement of `decide()` verdicts; error counts; median latency
  (hardware-specific, not comparable to the vendor's figure).

## 5. Decision rules

| Verdict | Condition on the ΔAUC 95 % interval |
| --- | --- |
| SUPPORTED | lower bound > 0 |
| NOT_SUPPORTED | upper bound < 0 |
| EQUIVALENT | wholly inside [−0.05, +0.05] |
| INCONCLUSIVE | anything else |
| INSUFFICIENT_EVIDENCE | below the minimum of §2, or GLiDE errors on more than 10 % of the cases |

One run, one analysis. A second run needs a new registration.

## 6. What each verdict allows

- **Any verdict:** no backend switch, no routing, no flag change. A result is recorded in `RESULTS.md`; NOT_SUPPORTED or
  EQUIVALENT is proposed to the operator as a negative-evidence entry.
- **SUPPORTED:** the operator may consider a registered shadow study or GLiDE as a local fallback for jev outages. Both
  are new decisions with their own registration, and NE-001 scope applies to them.
- If neither model beats the per-source base rate on Brier (as in NE-005 and the AR1 backfill), that is reported as the
  main finding: on these proposals no System One model adds forecast value, whichever has the higher AUC.

## 7. Limits

- The outcome on oracle lanes is decided by deterministic checks on the maker's work, not by the proposal text; a low AUC
  for both models is a plausible result and is not a fault of either.
- jev answered at proposal time; GLiDE answers later on the same text. Nothing the models see changed (hash check), but
  jev's answers come from one stored call and are not re-drawn.
- One checkpoint (0.4B) on one question set. Nothing here transfers to other judgments, to the 27B model or to the
  hosted Fastino API, which is a new external service and out of scope.
