# NE-015 — Leaked vendor system prompts as a capability source: REJECT

**Decided:** 2026-10-25 · **Subject:** `elder-plinius/CL4R1T4S` @ `a4d3da04` (tree `c0a3ae74`) and similar collections · **Evidence level:** decision on provenance, rights, trust and fit (no content fetched; nothing measured)

## Why not
- **Provenance:** the prompts' authenticity and completeness cannot be verified; a "vendor prompt" may be partial, outdated or fabricated.
- **Rights:** the text is vendor-proprietary and redistributed under AGPL-3.0. An inventory with source spans, or derived prompts, would republish it in this public repository.
- **Trust:** the collection contains instructions aimed at whatever reads it. Treated as data, it still carries injection risk into prompts, memory and skills.
- **Fit:** Djimitflo's verified gaps (see `docs/audits/djimitflo-aios-l4/BACKLOG.md`) are execution and accounting problems — remote cancel channel, effect states and remote job recovery, scheduler load scope, S0 tool mediation — not prompt design.
- **Precedent:** September 2026, 141 roborev "prompt-intel" scrapes of leaked system prompts were kept out of Djimitflo for the same reasons.

## Hypotheses already covered elsewhere
| Proposed | Where it lives |
|---|---|
| Hybrid retrieval improves edits | E1 (INSUFFICIENT: no labelled queries) |
| Explicit tool contracts | ToolBroker / S0 maker isolation |
| Independent verification | Exists: prod gates, checker F1 AUC 0.95 |
| Recovery checkpoints | Not needed for gym attempts (throwaway volumes); remote job recovery is in the backlog |
| Validated skills on unseen tasks | ACE-001, PL-001 |

## Allowed
A mechanism *idea* that targets a verified gap, implemented in Djimitflo's own words and evaluated through a pre-registered comparison and the existing gates. Official, licensed vendor documentation stays a normal source.

## Reopen
A pre-registered experiment on a verified gap, using no leaked text, with a frozen holdout. Reopening permits an evaluation, not ingestion.
