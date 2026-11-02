# Negative evidence

Falsified, rejected and inconclusive hypotheses are part of Djimitflo's learned capability boundary. This registry keeps
them so that no agent rediscovers a rejected approach and silently retries it.

- `NEGATIVE_EVIDENCE.yaml` is the machine-readable registry. It is written in JSON syntax, which is valid YAML 1.2, so any
  YAML or JSON parser reads it (no YAML dependency in the repo).
- Each entry has an `id`, `hypothesis`, `verdict` (REJECT, NO_GO, FALSIFIED or INCONCLUSIVE), `conditions`, `result`,
  `why`, `evidence` pointers, `allowed_follow_up`, `forbidden_reuse` and a `reopen_condition`.
- `forbidden_code_patterns` lists identifiers that may not appear in the server source while the entry's verdict is REJECT,
  NO_GO or FALSIFIED. `packages/server/src/__tests__/negative-evidence.test.ts` enforces this.
- `match_terms` (optional) lists distinctive names (dependencies, repositories) that identify the entry in generated text.
  Keep them conservative: a generic word gives false positives. Under `NE_GENERATOR_CHECK_MODE=shadow` generated proposals,
  dream mutants and discovery units naming a pattern or term get a `negative_evidence_match` judgment (record only).

## Rules

1. Never edit `result`, `why` or `evidence` of an entry. A new study gets a new entry.
2. Reopen only when `reopen_condition` holds. Record the reopening as a new entry that references the old one.
3. A rejected approach is not retried under another name. If a change needs a forbidden pattern, first record the new
   evidence here and change the verdict through review.

## Current entries

| ID | Hypothesis | Verdict |
|---|---|---|
| NE-001 | jev confidence routing for proposal pre-screen (PR #779) | REJECT |
| NE-002 | Memory rules improve maker outcomes | INCONCLUSIVE |
| NE-003 | Commons grounding path produces verified changes | REJECT |
| NE-004 | Gym tiers 4–6 are harder (H2) | INCONCLUSIVE |
| NE-005 | Clef Flash beats jev as System One backend | REJECT |
| NE-006 | Soup as fine-tuning backend | REJECT |
| NE-007 | ruDevolution for shipped-code inspection | NO_GO |
| NE-008 | REA integration | NO_GO |
| NE-009 | RuVector (ruvnet/RuVector), whole repository, as dependency or tooling — [details](NE-009-ruvector.md) | REJECT |
| NE-010 | MiroFish (LLM social simulation) as prediction or evolution substrate — [details](NE-010-mirofish.md) | REJECT |
| NE-011 | Unvalidated agent-ecosystem claims (ChrisRoyse repositories) — [details](NE-011-agent-ecosystem-claims.md) | REJECT |
| NE-012 | ruvnet agent ecosystem (ruflo/claude-flow, agentic-flow, agentdb, autogenous, ruClip, dream-machine) as dependencies, hooks or MCP servers — [details](NE-012-ruvnet-ecosystem.md) | REJECT |
| NE-013 | Mutant-kill feedback retry for exports-lane test makers (MFR-001) | FALSIFIED |
| NE-014 | AW-0 checkpoint / joint model reuse for software agents (PR #998) — [details](NE-014-aw0-joint-model.md) | REJECT |
| NE-015 | Leaked vendor system prompts (CL4R1T4S-style) as a capability source — [details](NE-015-leaked-vendor-prompts.md) | REJECT |
| NE-016 | Static procedure lines appended to a gym maker prompt (`ts-build-error-repair-v1`, PL-001) — [result](../procedure-loop/PL-001_RESULT.md) | REJECT |
