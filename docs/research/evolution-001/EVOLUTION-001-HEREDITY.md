# EVOLUTION-001 · 5 · Heredity: from observation to independent outcome

Conventions and source keys: file 1.

**Chain.** Every carrier is traced through six links:

| Link | Question |
|---|---|
| **O**bservation | what was seen? |
| **E**vidence | is it recorded with provenance? |
| **V**alidated learning | did an independent check confirm the lesson? |
| **I**nheritance | is it stored where later runs can get it? |
| **A**pplication | do later runs actually receive it? |
| **X** independent outcome | did receivers do better than non-receivers on an independent oracle? |

A link is **Y** (exists and evidenced), **P** (partial), **N** (missing) or **U** (unknown). L4 needs **Y** on every link,
with X controlled.

## 1. Chain per carrier

| Carrier | O | E | V | I | A | X | Highest level | Where it breaks | Tag |
|---|---|---|---|---|---|---|---|---|---|
| **Memory rules** | Y: failed runs → dream-state consolidation (82 ledger rows; 22-10 ACCEPT "2 new engineering rules") | Y: `memory_candidates` with `content_hash` seal | **P**: panel + human review. Approval is not an outcome test | Y: 187 promoted (25 engineering, 162 operational) | Y: 937 reads / 30 d, but **only 19 distinct rules** are read; credits go to 5 rule refs (S1) | **N so far**: rules 77/96 (0.802) vs withheld 28/31 (0.903), Fisher p 0.28 (EE). NE-002 earlier INCONCLUSIVE | L2 | V (no outcome validation before promotion); X trending negative. The registered CMH readout is due 27-10 | FACT |
| **Skill cards** | Y: verified and maker_failure runs | Y: `skill_cards` (102, sha256) | **N**: all 102 are `candidate`; nothing validates a card | P: the lane playbook (deterministic, `lane-playbook.ts`) | P: **gym trial only** (`g-d14c1156`); 0 prod consumers (L3v2) | U: trial pending | L1 | V and prod A missing | FACT |
| **Genome lines** | Y: day's failures + clusters | Y: `maker_genomes`, guard, evidence citations | P: paired trial on a frozen holdout. 0 promotions in 16 settled trials (no headroom/blind at epoch 0) | P: an `active` status would store it | **N**: prod injection not built (`loop-daemon.ts:617-626`); `GENOME_APPLY_MODE` unset | N | L1 | V never passed; prod A does not exist | FACT |
| **Knowledge** (KB pages, Frontier Experts, discoveries) | Y: 9 331 discovery events / 60 d; 1 313 KB pages | P: discovery → proposal `not_linked`; 0 proposals cite expert units (EE `lineage`, `knowledge_links`) | P: `knowledge-fitness.ts` (n < 5 → insufficient) | Y: KB in ACE arm R; 1/18 genomes carry knowledge refs | P: ACE R arms only | **N so far**: ACE R interim −0.172 (descriptive) | L1 | E (no provenance from discovery), X | FACT |
| **Similar / recent examples** | Y: verified tests | Y | N: example fitness not estimated | Y | Y: ACE S arms; K1 control often has **0 examples**, because recent tests are unmerged (ACE Amendment 1) | interim −0.024 | L1 | V, X | FACT |
| **Merged loop tests (code on main)** | Y | Y: PR, lease, provenance (`made_by_lease` 418 edges) | **Y**: executed gates + validated checkers (F1, SEC-F1) | Y: on `main` | Y: every later run executes them | **P**: retained (16/16 re-run pass); whether they catch later regressions is **U** (kill share now 0.40, n 15; 0 negatives) | **L3** | X: "improved later performance" is unmeasured | FACT |
| **Bandit posterior** | Y: `skill_outcomes` | Y | P: attribution filters non-maker failures; CAR audited 0 | Y | Y: share 0.8 cap since 20-10 | **N**: no bandit-vs-no-bandit estimate; OPE +0.0018 [−0.0112, 0.0144] | L1 for effect | X | FACT |
| **Negative evidence** (NE registry) | Y: experiments | Y: YAML + protocol sha | **Y**: pre-registered falsification (e.g. NE-013) | Y | P: humans + `NE_GENERATOR_CHECK_MODE=shadow` | **Y as prevention**: `MFR_001_MODE` was not built (FACT). A prevented loss is not a measured gain | L2 (L3 for the individual entries that carry a controlled result) | A automated only in shadow | FACT |
| **Commons** (evidence room, falsifier, residents) | Y: 771 summary threads | P | N: **0 typed replies** (S2); falsifier 0 runs (allowlist empty); NE-003 REJECT | N | N | N | L1 | E→V | FACT |
| **Decision intelligence** (committee, forecasts, panel, jev) | Y: committee forecasts 28 per member in 7 d (S2); panels | Y | N: 0/20 forecasters decision-grade (gate D); jev κ(outcome) 0.38, not enforce-eligible; NE-001 | P: `kb_passage_relevance` acts in enforce (unvalidated) | P | N | L1 | V | FACT |
| **Outcome-learning assessments** | Y | Y: 70 rows | **N**: the 12 rows with `signal_status SUPPORTED` are all synthetic "worldlab" capability ids with near-zero-width CIs (e.g. [0.207, 0.213]; S2), i.e. simulation output, not observation. 2 FALSIFIED, 52 UNDETERMINED | N | N | N | L1 | generated artefact, not evidence | FACT |

**Conclusion (FACT / INFERENCE).**
- **No carrier has a complete O→X chain at L4.**
- **Two chains reach prod behaviour and have an outcome reading:**
  - merged tests: L3, but "improved later performance" is unmeasured;
  - memory rules: L2, outcome trending against the rules.
- The carrier the Darwin loop is built around, genome lines, breaks at **V** (never passed) and at **A** (no prod path).

## 2. Stored but not consumed (no decision or behaviour reads it)

| Store | Volume | Consumer | Tag |
|---|---|---|---|
| `skill_cards` | 102 | playbook gene in gym trials only | FACT |
| `skill_genomes` | 0 rows (#773 schema) | none | FACT |
| Commons evidence-room threads | 771 + 22 follow-ups, 0 typed replies | none | FACT (L3v2, S2) |
| `commons_falsifier_runs` | 0 | none (allowlist empty by design until S0 isolation) | FACT |
| `outcome_learning_assessments` | 70 (12 synthetic "SUPPORTED") | cockpit CLY metric (2 completed, both FALSIFIED) | FACT |
| Graded scores on leases | every test-writing run | nothing acts (`graded-fitness.ts:13-15`; contest shadow) | FACT |
| Settlement execution | 16 rows | nothing acts (shadow by design) | FACT |
| Committee forecasts | ≈ 28 / member / 7 d | none (gate D red) | FACT |
| Value-allocator tables | daily | none (shadow; no dashboard page) | FACT (L3v2) |
| Frontier Experts / KB | 4 401 papers, 1 313 pages | ACE R arms; 1 genome | FACT |
| `genome_trial_results` diagnostics | 8 | Gate A (unknown) | FACT |

## 3. Hereditary, historical and ecological memory mapped to existing stores

| Kind | Definition used here | Existing stores | Shapes behaviour? | Tag |
|---|---|---|---|---|
| **Hereditary** | transmitted into later agents' behaviour | promoted memory rules (prompt); K1/ACE examples; maker template; bandit species mix; **genome lines and playbook (gym only)**; merged code + tests | yes (prompt / species), except genomes and playbook in prod | FACT |
| **Historical** | the record of what happened, read by analysis and gates | `skill_outcomes`, `judgments`, `loop_events`, `worker_leases.metadata` (graded, failure, risk_inputs), provenance edges, `genome_trial_results`, `dream_ledger`, `evolution_estimates`, NE registry, experiment registry | indirectly (through humans, gates and dream inputs) | FACT |
| **Ecological** | the shared environment every agent is selected in | repository `main` + test suite; task pools and frozen holdouts (epoch 0 exposed, epoch 1 fresh); gates and charter; caps (test-gap 8/day, mutation 4/day, gym 40/day); provider limits (Ollama weekly limit); KB | yes: it sets selection pressure | FACT |

**INFERENCE.**
- The ecological memory, meaning the growing test suite on `main`, is the store that accumulates most reliably.
- Each merged test changes the environment that later makers and gates run in.
- That is cumulative **niche construction**, not cumulative capability of the agents.
- Whether the niche gets *harder in a useful way* is measurable with settlement execution's kill share, once maker-time
  pairs exist.
- Today 0 pairs exist (EE `settlement_execution.kill_share.n_paired = 0`), so this is **UNKNOWN**.

## 4. Smallest repairs that would complete a chain (proposals; operator decides acting steps)

1. **Memory rules, link V.** Use the 27-10 readout as the validation. If no positive effect: freeze growth (G3.3, already in
   plan). Do not add more rules before then. 48 candidates were added in 7 d (L3v2).
2. **Genomes, link A.** Do not build prod injection before one promotion exists with a valid, powered trial (YAGNI, Y3d
   rule). Fix the trial's power first (file 6 E0).
3. **Merged tests, link X.** Pair settlement-execution kill share with the maker-time score. Today `n_paired = 0`: the
   maker-time graded score is present on only some runs, and the settlement seed differs. This is the cheapest route to a
   discriminating retention signal on the only L3 chain. It needs no new data source. It is still not L4: retention is not
   improved later performance.
4. **Skill cards, link V.** Count a card as validated only through a trial or experiment outcome, never by card count.
