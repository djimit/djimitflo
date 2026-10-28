# HERMES-DIAG-001: a held-out diagnostic and transfer case for adapter failures (pre-registration)

Status: **draft pre-registration, not started, not registered.** Written 2026-10-24 against origin/main `e3dd61ec`. Nothing
in this document authorises a run, a host change, a model call, credential access or a configuration change. It is **not**
an entry in `packages/server/src/services/experiment-registry.ts`, and it does not start until the operator gives a go and
the WIP limit has a free slot (see [WIP limit](#wip-limit-and-start-condition)).

Source of the case: Agent Commons revalidation 2026-10-24, `utilisation-spec.md` § "One concrete first case" and § "What
would justify more evolutionary autonomy", together with `operating-model.md` § "Proposed causal comparison". These audit
files are a local audit pack. They are not in the repository at `e3dd61ec`, so they are pinned here by sha256:

| File (local audit pack `docs/audits/agent-commons/`) | sha256 |
|---|---|
| `revalidation-2026-10-24/utilisation-spec.md` | `22e2581b6915e577107ab65c22b5e4ff3a3b8f58d8e29b51ba116afa0b6b36d8` |
| `operating-model.md` | `5a2c5cba9789b6032997397ac9b720c2cf3b98ec81b85101c9908619649899f6` |
| `revalidation-2026-10-24/README.md` | `3a019a6a01660294c252862aaf40099f08963ba3421059927f9596d5735d9b97` |

## Question

Does an evidence-backed diagnostic recipe help a peer agent tell an **adapter/session-parameter failure** apart from a
**provider/model failure**, an **authentication failure** or an **unrelated transport failure**? A correct diagnosis has to
come without wasteful retries and without credential rotation.

A second question uses the same cases. Does one bounded peer challenge improve independently evaluated diagnosis
compared with an equal-budget single agent, or with two independent agents and a fixed selection rule? This is the
comparison the operating model specifies as the evidence that could justify more evolutionary autonomy.

## The solved case (source material, never shown to discovery agents)

| | Author-reported (PR #990 body, commit `936b9347`) | Independently observed (revalidation 2026-10-24) |
|---|---|---|
| Symptom | Hermes on Eve-V heartbeats, every reply turn fails: processed 0 / failures 4 per poll "since ~2026-10-19" | Bounded native journal window (from 15:24Z, 2026-10-24): processed 0 / failures 4 per poll until 16:54Z, then processed 1 / failures 0 from 16:57Z, one failure=1 poll at 17:07Z |
| Root cause | Hermes 0.22.4 (updated 2026-10-21; the commit title says "Hermes 2026.10") rejects `--source djimitflo-social` with `invalid_params` **before any model call**. Every other flag works. `--source tool` returns a normal reply | Not re-observed. The audit did **not** rerun the bisection or any paid inference |
| Method | Bisection on Eve-V: read-only work plus one-token test calls | Not observed |
| Fix | `--source` = `HERMES_SOURCE` env, default `tool` (`scripts/agent-social-poller.py`, `run_hermes`) | Source change verified. The native script sha256 `5f50a4ac…fa5eb13` (243 lines) equals the repository script at `e3dd61ec`. Later messages were accepted |
| Test | `test_hermes_uses_a_session_source_hermes_accepts` (`scripts/test_agent_social_poller.py`), a mocked argv assertion | 13 existing poller tests pass locally. The test is mocked: it proves the argv, not that Hermes accepts the value |

One discrepancy is open: failures are dated from ~2026-10-19, but the Hermes update is dated 2026-10-21. This protocol
does not resolve it and does not treat the solved case's timeline as proven. A fixture must not encode "the version bump
explains everything".

Packet for the solved case: the failing and successful invocations, the redacted error category (`invalid_params`),
Hermes 0.22.4, the adapter before and after (`936b9347`), the argument difference, the mocked test and the resource bounds.
Stage 2c uses it **only as an adoption test**. It never enters stage 2a or 2b discovery cases, because its answer is
public in the repository, in PR #990 and in this document.

## Why hidden fixtures

If a fixture's logs name the offending argument, it tests **extraction**, not diagnosis. NE-013 (MFR-001) shows the
related failure: showing the oracle teaches to the oracle. For that reason:

- Fixtures are generated from the **structure** of the solved case, not its strings. They use a fictional CLI (`relayctl`,
  a deterministic local stub) with versions, flags and values that differ from the real ones. `--source djimitflo-social`
  and `--source tool` never appear in a discovery fixture.
- The error text **never names the rejected parameter**. The rejected flag appears in the packet only where every flag
  appears: in the full argv and in the `--help` listing.
- Surface signals are deliberately confusable. A provider-side "invalid parameter" (for example a model that rejects a
  generation parameter **after** dispatch) uses the same coarse category as the pre-dispatch session-parameter rejection.
  The poller-level summary is only `processed/failures` counts plus a coarse category and exit code, as on Eve-V.
- Telling the classes apart requires evidence the agent must gather inside its budget. Was a request dispatched (the stub
  emits a request/usage line only after dispatch)? What changed in argv/env/version against the last success? Does a
  one-flag-at-a-time probe change the outcome? Does a credential-free status probe separate auth from the rest?
- The answer key (class, rejected flag, an accepted value) is stored outside the agent-visible packet. A static leak
  scanner gates every fixture (stage 1, check S1).

## Case classes

| Class | What the stub does | Correct disposition |
|---|---|---|
| **T1 adapter/session parameter** (target) | A newer stub version rejects one session/config flag value pre-dispatch with a generic `invalid_params`. The last-success invocation (older version) used identical argv | Class T1. Name the flag and an accepted value. Submit a contract test that **fails** on the original argv and **passes** on the fixed argv against the stub. No credential action |
| **C1 provider/model** | Dispatch happens, then upstream 5xx, `model_not_found`, or a provider-side parameter rejection | Class provider/model. No adapter-argument change. At most one retry after the stated backoff for a transient subtype. Route to the provider/model owner |
| **C2 authentication** | Expired or insufficient-scope credential (the packet holds only redacted dummy material) | Class auth. No adapter-argument change, **no rotation**. Escalate credential repair to the operator |
| **C3 unrelated transport** | Local socket refused, DNS failure or a timeout before any CLI output | Class transport. No adapter or credential change. Route to the host/network owner |
| **C4 current version accepts the default** (overgeneralisation check) | A version bump and a failure signature are present, as in T1, but the current version accepts every adapter flag. The cause is a C1/C2/C3 fault, or a transient that has already recovered | Session parameter **rejected as the cause**, no flag change. Report the actual class, or "no change needed" for the recovered transient |

Template families form the clustering unit: 6 T1 families by flag kind (source/session tag, profile, channel, client
name, output mode, toolset spec) and 2–3 subtypes for each control class. Difficulty strata, recorded per case: whether
`--help` enumerates accepted values (yes/no) and the argv length (8–12 flags).

Case mix for each block of 20: 8 T1, 3 each of C1, C2, C3 and C4. Pilot and confirmatory fixtures use disjoint seeds, and
a case is never reused across stages.

## Treatment: the recipe (R+)

The recipe is a separate file, `HERMES-DIAG-001-RECIPE.md`. It is written from the solved case and **frozen by sha256
before the fixture generator's parameters are frozen**, so it cannot be tuned to the fixtures. Its author is not the
fixture author. It must be answer-agnostic: it describes the method and never names `--source` or any other flag. It
contains:

1. **Applicability:** a CLI/runtime adapter whose failure signature is consistent with pre-dispatch rejection.
2. **Steps:** (a) establish whether a request was dispatched; (b) diff argv, env keys (names only) and version against the
   last success; (c) minimise one flag at a time with probes that fail before dispatch at no cost; (d) separate auth with a
   credential-free status probe; (e) confirm with a contract test that fails before the fix and passes after it.
3. **Stop rules:** no identical re-invocation after a deterministic failure; never rotate credentials on parameter
   evidence; auth evidence goes to the operator.
4. **Provenance:** a link to this protocol, PR #990 and the author-reported versus observed split above.
5. **Expiry:** Hermes 0.22.x and adapter `936b9347`, or until either changes. Recheck by 2027-01-24.

The recipe stays a **candidate**. Admission of an exact version follows the existing skill/memory route, and nothing
in this protocol admits it.

## Arms (equal total budget, same model identity, evidence and permissions)

| Cell | Protocol | Recipe |
|---|---|---|
| A− | Single agent: initial answer, then one self-review revision. Total budget 2b | absent |
| A+ | As A− | present |
| B− | Two independent agents, b each, no exchange. Fixed selection rule (below) | absent |
| C− | Two independent agents, 0.8b each for the initial answer, then one focused challenge and one revision each at 0.2b. Same selection rule on the revised answers | absent |

Optional cells B+ and C+ are exploratory and run only if the authorised budget covers them. They never enter a
confirmatory claim.

- **Budget b** is a fixed ceiling on tokens, stub probe calls and wall-clock time, set in the stage 2a authorisation
  before any case runs. Probe calls count against the budget. The harness measures usage itself. A cell-run whose usage
  cannot be measured is marked resource-censored, never "free" (Hermes usage rows have no token totals, per the audit).
- **Selection rule (B and C):** if the agents agree on class (and on the flag for T1), use that answer. Otherwise take
  the higher stated confidence. On a tie, use a coin seeded per case (seed `24102026`). The rule never consults the
  answer key or the evaluator.
- **Same everything:** one model identity and runtime version across all cells. The permission set is the stub CLI, the
  packet and a scratch directory. No network, no djimitflo repository, no git history, no PR text, no answer keys, no
  other cells' outputs and no real credentials. Each cell-run gets a fresh agent instance and a fresh home directory,
  with persistent memory and skills off. Cell order per case is randomised with the same seed.
- **Initial answers are preserved** in A and C, so harmful revisions (initially correct, finally wrong) and recovered
  errors are both counted. B records "harmful selection" when one agent was right and the rule picked the other.

## Outcomes

- **Primary:** independently evaluated **correct disposition per assigned case** (binary). Correct means the class is
  right; for T1 the flag and an accepted value are right **and** the submitted contract test discriminates (it fails on
  the original argv and passes on the fixed argv when the evaluator runs it against the hidden stub); for C1–C4 there is
  no adapter-flag change. The evaluator is the deterministic scorer plus that executed test. No agent scores its own
  answer.
- **Counted secondaries, per case:**
  - Wasteful retries: identical (argv, env-hash, stdin-hash) re-invocations after a deterministic failure. One retry
    after backoff on a C1 transient is allowed.
  - Credential rotations: calls to the `rotate_credential` stub or changes to credential env keys. Never correct in this
    protocol.
  - Harmful revisions, recovered errors and harmful selections.
  - The false-blame rate on C1–C4: proposing a flag change when none is needed.
  - Probes used, tokens, wall-clock time and contract tests rejected as non-discriminating.
- **Missing data:** the analysis is intention-to-treat. An assigned case with no delivered answer counts as incorrect.
  Harness infrastructure failures are retried at most twice; after that the case is INFRA_CENSORED and reported per cell.
  A per-protocol sensitivity analysis excludes infra-censored cases. Reports always give the numerator and denominator.
- **Blinding:** the evaluator sees only the normalised final structured answer and the contract test. Arm traces and
  challenge transcripts are stripped. Human spot checks (≥ 25 % of pilot cases, arm-blind) audit the scorer; they do not
  replace it.

## Stages

**Stage 1: mocked contract test only.** No model inference of any kind, no credentials, no hosts beyond the local
machine, and no production read. A separately reviewed PR implements the stub, the fixture generator, the leak scanner,
the scorer and the budget accounting. Scripted, deterministic reference policies run through every cell. Gate (all
must pass; the stage may iterate, because it produces no outcome data):

- **S1 leak:** in no agent-visible artefact does the rejected flag or value appear outside the full argv and `--help`. An
  extraction-only policy (string/regex over the packet) identifies the T1 flag no better than 1/k, where k is the number
  of flags in the argv.
- **S2 discrimination:** the oracle policy scores 100 %. An "always blame a session flag" policy scores 0 % on C1–C4.
  "Always rotate", "retry until success" and "always transport" policies get the exact scripted counts.
- **S3 test check:** the evaluator rejects a contract test that passes on both the original and the fixed argv, and one
  that fails on both.
- **S4 accounting:** budgets are equal across cells within 1 %. Two scorer runs on the same outputs agree exactly.
- **S5 isolation:** a secret scan of packets and fixtures finds no credential material. A network-egress probe from the
  sandbox fails.

At stage 1 exit, the recipe sha256, the generator parameters, the seeds, the fixture manifest sha256 and this document's
sha256 are recorded in one commit. Fixtures cannot change after that commit without a dated amendment that precedes any
stage 2 data.

**Stage 2: agent runs and native transfer. Each step needs its own operator authorisation**, naming the model/runtime,
hosts, budget ceiling, credential scope (none for 2a/2b) and whether inference is local or paid.

- **2a pilot, 20 cases × 4 cells (80 cell-runs): logistics only.** It checks delivery, budget parity, scorer
  agreement with blinded spot checks, sandbox isolation and missingness. It also estimates the **pooled discordant
  proportion** (b + c)/n per contrast. Only that pooled proportion, never its direction (b − c) or any arm's accuracy,
  goes to the person who sets n. Pilot cases never count toward a confirmatory result. The pilot is not evidence of
  benefit or harm.
- **2b confirmatory.** n is fixed by a dated amendment after 2a and before any 2b case runs (see [Sample size](#sample-size-and-feasibility)).
  It has fresh fixtures and the same cells.
- **2c native adoption/transfer.** It runs on an **isolated** comparable Hermes adapter, never Eve-V and never
  production. It has two checks. (i) The real solved case on Hermes 0.22.4 with the pre-fix argv: does a recipe-equipped
  peer find and fix it without rotation? (ii) A current Hermes version that accepts the default: does the peer leave the
  flag alone? This is a pass/fail demonstration with tiny n and not a statistical claim. A mocked test cannot certify this
  stage, and only 2c speaks to native readiness. Its probes may dispatch real one-token calls, which is why it needs its
  own credential and budget authorisation.

## Sample size and feasibility

- **Pilot:** 20 cases. That is enough to exercise logistics and estimate discordance, and far too few for any efficacy
  statement.
- **Confirmatory planning:** paired binary data, McNemar normal approximation, minimum relevant gain 15 points,
  two-sided α 0.05, power 0.80. The required n by assumed discordance:

  | Discordance | Family 1 (α .05) | Family 2, first Holm step (α .025) |
  |---|---|---|
  | 0.30 | 102 | 124 |
  | 0.40 | 137 | 166 |
  | 0.50 | 172 | 209 |

  The operating model's illustration (≈ 140 pairs at discordance 0.40) matches. Final n = the larger of the two family
  requirements at the pilot's pooled discordance, **capped at 210 cases**.
- **Feasibility limits, stated before any data:**
  - Fixture supply is cheap, because it is generated.
  - Agent inference is the cost: 4 cells × n cases × up to 2b each. If the projected cost to reach n exceeds the
    authorised ceiling, or if required n > 210, stage 2b does not start and the result is **pilot-only /
    INSUFFICIENT_EVIDENCE**.
  - All cases derive from about 15 template families of one solved case. The effective sample is clustered, and results
    generalise at most to this fixture family, not to real production failures. A cluster bootstrap by template family
    is reported as a sensitivity analysis.

## Decision rule

Two families are registered separately, each at FWER 0.05.

**Family 1, recipe (H1): A+ vs A−,** paired by case. Exact two-sided McNemar test, with a Tango score 95 % CI for the
paired difference (as in TG-001).

- **SUPPORTED:** p < 0.05, the point estimate is ≥ 15 points, **and** all of these non-regression constraints hold:
  - the false-blame rate on C4 (and on C1–C3 pooled) is not higher in A+ by more than 5 points (upper 95 % bound);
  - rotations in A+ total 0, or are no higher than A−;
  - wasteful retries per case are no higher than A−.
- **REJECTED** (no material benefit within this fixture family): the upper 95 % bound is < 15 points.
- Anything else is **INCONCLUSIVE → INSUFFICIENT_EVIDENCE**. There is no extension and no re-test until significant;
  any follow-up needs a new registration.

**Family 2, protocol (H2): C− vs A− and C− vs B−**, Holm-adjusted, same test and CI.

- C is supported over a comparator only if its adjusted test passes, its point estimate is ≥ 15 points, and C's harmful
  revisions do not outnumber its recovered errors.
- B− vs A− is descriptive only.

What the results allow:

- **Recipe → candidate admission:** H1 SUPPORTED **and** both stage 2c checks pass. The candidate then enters the
  existing skill/memory admission route as an exact version with its conditions and expiry. This protocol does not
  admit it.
- **H1 REJECTED:** a candidate `NEGATIVE_EVIDENCE.yaml` entry is proposed in its own PR, scoped to this fixture family.
- **H2 supported:** this is evidence level 2 ("added value") on this fixture family only. Evidence level 3 (cumulative
  benefit) still requires fresh-task transfer to another capable agent and later survival. No result here justifies more
  residents, more reflection storage, higher proposal throughput or a change to the reflection cap.
- **Safety stop (any stage):**
  - a sandbox egress or credential-access attempt;
  - credential material in a packet or output;
  - a cost overrun beyond the ceiling;
  - pilot delivery below 80 % of assigned cell-runs;
  - scorer nondeterminism.

  A stop halts the stage for review. Stopped data is reported, never silently dropped.

## WIP limit and start condition

`EXPERIMENT_WIP_LIMIT = 4` (G1.5) governs the oracle-goal population. At `e3dd61ec` the registry defines six active
oracle-population experiments. Four count against the limit (ACE-001, STE-001, X1, memory-holdout), and MAKER-DEPS-001
and F2 run under `approved_over_limit`. So **no slot is free at this commit**. The live state depends on recorded
verdicts, as read from the registry report.

HERMES-DIAG-001 uses synthetic fixtures, not oracle goals, and none of the four `ExperimentPopulation` values fits it.
By operator instruction it is still treated as a new experiment that **counts against WIP 4**. It starts only when all of
the following hold:

1. The operator gives an explicit go.
2. The registry report shows a free slot (counted < 4), or the operator records an over-limit reason of at least 20
   characters.
3. A separate PR registers it, with a population value, flag, target n and stop date. This PR does not.

The earliest plausible slot is after memory-holdout reads out (stop_by 2026-10-27).

## Stop dates

- **Lapse:** if stage 1 has not started by **2026-12-15**, this registration lapses. Hermes versions and the recipe
  expiry go stale, so a restart needs a new registration.
- **stop_by: 2027-01-22** (registration + 90 days, the 2026-10-19 amendment cap). On that date the experiment reads out
  at whatever n it has reached. If 2b has not reached its registered n, the result is INSUFFICIENT_EVIDENCE.
- **Recipe recheck:** 2027-01-24, or earlier if Hermes or the adapter changes.

## Out of scope

- Any production read or write. Any change to Eve-V, `djimitflo-social.service`, the installed poller or Hermes on any
  host. Installing or upgrading Hermes outside the isolated 2c adapter.
- Paid inference in stage 1. Any inference at all before a stage 2 authorisation.
- Handling, exposing or rotating real credentials. Credential repair stays an operator action.
- Registering this experiment in `experiment-registry.ts`, adding a population value or flag, or changing the poller or
  its tests.
- Commons flags (`SOCIAL_AUTOPILOT_*`, evidence rooms, falsifier, grounding apply) and `REFLECTION_PROPOSALS_MAX_PER_DAY`.
  Proposal, skill or memory admission of the recipe.
- The second bounded case (the Commons feed displaced by 51 record-only rooms). It needs its own protocol.
- Different-model or cross-runtime transfer, which belongs in a later registered replication. Claims of general peer
  superiority, ROI, durable learning or swarm benefit.
- Using the solved case (PR #990) as a discovery fixture.

## References

- PR #990 / `936b93479920d5c251cf006bc42771c9142fa136`, `scripts/agent-social-poller.py` (`run_hermes`),
  `scripts/test_agent_social_poller.py`.
- `packages/server/src/services/experiment-registry.ts` (`EXPERIMENT_WIP_LIMIT`, `wipCheck`, `experimentDefs`).
- `docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml`: NE-003 (Commons grounding path), NE-013 (showing the oracle
  teaches to it).
- Format and analysis conventions: `docs/research/ace/TG-001_PROTOCOL.md` (Tango CI, censoring, frozen manifest) and
  `docs/research/evolution-001/EPOCH1-TRIAL-PREREG.md`.

Verify: `sed '$d' docs/research/commons/HERMES-DIAG-001.md | shasum -a 256` (hashes every line above the last).
sha256 (every line above this one): 03982b4fddb392582e820744980f822aad202295235fd603b144d93649fe6f79
