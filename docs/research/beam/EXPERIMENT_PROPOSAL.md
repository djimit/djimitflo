# BEAM-001 Phase 5: experiment proposal (design only, nothing built or run)

**Question:** does replacing glm-5.2 with Beam in the opencode maker or checker roles raise verified, policy-compliant outcomes per unit of cost? And is any effect bigger than what a workflow fix with the incumbent model achieves?
**Status:** PROPOSED. Before any runner code is written, the protocol text must be committed and its sha256 recorded (same practice as SEC-F1 and R2). Spend needs an operator decision.

## 1. Guardrails (all stages)

- **No prod change.** Nothing runs inside `djimitflo-live`, and nothing is written to `/data/djimitflo.sqlite`. Prod `/srv/djimitflo/opencode.json` and runtime.env stay unchanged.
- **Throwaway container.** Runs use the prod image (as SEC-F1 did on 21-10): `--entrypoint node`, user 1001, no `/data`, no compose network. The env-file holds only `OPENCODE_*` and `OLLAMA_*` names plus the referenced key, umask 077, and is deleted afterwards. A **separate** opencode.json (prod's plus `"beam:cloud"`) is mounted `:ro`.
- **Task sets.**
  - TG-001 task ids (the r2 set and its extension pool) are excluded.
  - Gates A–D are untouched.
  - Paused discovery stays paused.
  - The frozen epoch-1 holdout (manifest sha `37b8172e…`) is reused **read-only as a paired slice**. Only the 40 mined + 40 mutant items are used; the 5 write_test items are excluded because they overlap the TG-001 task kind. No gym rows, no freezes, no promotions.
- **SEC-F1 items** (#939/#941, 46 items, prompt hash `dd101494…`) are reused read-only. The 21-10 glm-5.2 results serve as the A0 checker arm, with no re-run.
- **Data.** Only public repo code (djimitflo, MIT) and the public upstream advisory-fix items go to Ollama Cloud. No secrets, no prod rows, no private data.
- **Provider.** The existing Ollama Cloud account. The VPS never calls the workstation.
- **No verifier is removed.** Every arm passes through the same deterministic checks and oracle gate. Model arms change only the maker or checker model.

## 2. Arms

| Arm | Maker model | Effort | Workflow | Purpose |
|---|---|---|---|---|
| **A0** | glm-5.2 (incumbent) | provider default | prod harness as on 21-10 (prompt, caps, `OPENCODE_MAX_RUN_TOKENS=1 000 000`, timeout 600 s) | baseline |
| **A1** | beam:cloud | as served (template default `max`) | same as A0 | pure model swap |
| **A2** | beam:cloud | reduced (`--variant low`/`medium`, or provider option) | same as A0 | effort control. **Runs only if Stage 0 shows that effort control reaches Beam through opencode**; otherwise the arm is dropped and reported as such |
| **A3** | glm-5.2 | default | workflow simplification: MAKER-DEPS-001 arm-B prepared dependencies (no environment bootstrap in the maker loop) + a step cap pre-registered at the A0 p90 step count | tests whether the bottleneck is workflow, not model |

Pre-registered contrasts: **A1−A0** (model), **A2−A1** (effort), **A3−A0** (workflow). Holm correction is applied over the three.

## 3. Metrics (pre-registered)

- **Primary.** Per task, `verified` = the oracle gate passes. For mined items that is the replayed fix's tests going red→green under the gym's graded rules; for mutant items it is the seeded mutant killed and all deterministic checks green. Paired by task.
  - A1−A0 is tested as **non-inferiority with margin −15 pt**.
  - A3−A0 and A2−A1 are tested as two-sided.
- **Co-primary (cost).** Total tokens per attempt and per verified (uncached in, cached, out, reported separately), as a paired log-ratio. Success = the 95 % CI for tokens per verified excludes 0 in Beam's favour.
- **Secondary.**
  - wall time;
  - failure class distribution with the DI-001 classes;
  - **new failure classes** (tool-loop or protocol errors, Harmony/XML artefacts in output, empty diffs);
  - diff size;
  - weak-assertion flags;
  - R2 fail-before/pass-after verdict, computed offline.
- **Checker slice (Stage 1).** Catches out of 20, false rejects out of 26, AUC, non-decisive rate, and tokens, against the 21-10 glm-5.2 results (19/20, 0/26, AUC 0.975, 2.00 M tokens).
- **Policy compliance.**
  - zero scope or diff-limit violations accepted;
  - zero suppression or test-deletion cheats accepted (finding-fix anti-gaming regexes applied to every diff);
  - zero secrets in diffs.
  - Any single accepted violation fails that arm.

## 4. Sample size, from measured variance

- **Discordance.** TG-001 r2 had 7 discordant pairs out of 19–20 (≈ 0.35). The 30 d opencode verify rate is about 0.39.
- **Paired binary.**
  - With n = 80 tasks × 1 replicate, the minimum detectable two-sided difference is about 18 pt (α 0.05, power 0.8, p_disc 0.35).
  - Non-inferiority at margin 15 pt (one-sided α 0.05) needs about 96 pairs.
  - **Design: 80 tasks × 2 replicates per arm**, analysed with a task-cluster bootstrap. With assumed within-task outcome correlation ρ ≈ 0.6, the effective n is about 100, which gives power ≈ 0.8 for the −15 pt margin.
  - **INFERENCE:** a 10 pt margin would need about 220 pairs. The frozen slice cannot supply that, and fresh task supply is about 6 per 5 days (17-10 supply check). So the experiment can rule out large losses only. It **cannot** prove parity within 10 pt.
- **Tokens.** Completed-maker log-SD is 0.67 (30 d). With within-task ρ 0.5, a 20 % reduction is detectable at n ≈ 70, so 80 is enough.
- **Stop rules.** Fixed n. No peeking. Exceptions:
  - Stage 0 failure rules (below);
  - abort any arm if accepted policy violations ≥ 1;
  - pause all stages if prod's Ollama weekly usage passes 50 %, read by the operator on the usage page.

## 5. Stages and spend

| Stage | What | n | Tokens (estimate, incl. cache) | List-equivalent $ | Decision rule |
|---|---|---|---|---|---|
| **0 (smallest)** | A1 only, opencode + beam:cloud on 10 mined items. Also checks `--variant` effect (2 extra runs at `low`) | 12 runs | ≤ 6 M (median 0.40–0.70 M per run) | ≈ $2–4 at glm-5.2 rates; Beam's Ollama rate UNKNOWN | **REJECT Beam for opencode roles** if ≥ 3/10 runs end in tool-loop or protocol errors, or if Harmony artefacts appear in diffs. Otherwise go to Stage 1 |
| **1** | Beam security checker on the 46 SEC-F1 items (A0 = 21-10 glm-5.2 run, reused) | 46 | ≤ 3 M (glm-5.2 used 2.00 M) | ≈ $1–3 | Viable challenger if catches ≥ 18/20, FR ≤ 2/26, non-decisive ≤ glm-5.2's, and tokens ≤ 0.8 × 2.00 M. **Never** a replacement decision on n = 46 |
| **2** | A0–A3 on 80 epoch-1 items × 2 replicates | 640 runs | ≈ 350 M (0.55 M mean per run), of which ≈ 27 M uncached | ≈ $110–120 total (glm arms ≈ $0.21/run × 320; Beam arms at third-party $0.25/$1.00 ≈ $0.14/run × 320; UNVERIFIED) | ADOPT_CONDITIONALLY for a 10 % bandit-share prod arm (a separate operator decision, after F2 v2 and MAKER-DEPS-001 read out) only if A1 is non-inferior **and** tokens per verified fall with CI excluding 0 **and** A1−A0 > A3−A0. If A3−A0 ≥ A1−A0, the bottleneck is workflow and Beam is REJECTED |

**Recommended now: Stages 0 + 1 only.** Combined that is ≤ 9 M tokens, about $3–7 list-equivalent on the existing Ollama Cloud account, with 0 prod writes, one throwaway container and about 2 h of runner time.

Stage 2 is about 10 prod-weeks of maker token volume (prod uses ~36 M per 7 d for makers + reviewers). On the legacy weekly-limited plan it **must not run** until one of these holds:
- (a) the operator switches to a credit plan;
- (b) a separate spend cap or key is set;
- (c) it is spread over ≥ 4 weeks, off-peak, gated by the calibrated budget throttle.

The Reflection first-party API (free beta) would avoid the Ollama limit. It is a new provider, though, and a serving difference would confound A1 vs A0. **Operator decision; not recommended.**

## 6. Build needed later (not done; needs approval)

- A Stage 0/2 runner that replays epoch-1 items in a throwaway container. The pattern is the #939 SEC-F1 runner plus the gym's graded-mutant machinery.
- An opencode.json overlay file.
- A Stage 1 runner variant of #939 with `--model ollama/beam:cloud`.
- Effort wiring (`--variant`) only if Stage 0 shows it works.
- No change to prod code paths.

## 7. What would falsify the Beam case early

Any of these at Stage 0 or Stage 1 means REJECT for that role, recorded as an NE entry:
- opencode tool-loop incompatibility;
- tokens per attempt ≥ A0 at `max` effort with no working effort control;
- a lower SEC-F1 catch rate.
