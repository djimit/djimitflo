# Frontier Expert Intelligence — Threat model (§48, §49)

Trust boundaries: KNOWLEDGE TRUST (what evidence says) ≠ IDENTITY TRUST (who a person is) ≠ EXECUTION TRUST (what code may run) ≠ AUTHORIZATION (who may promote). An expert row is never an executing principal; evidence is never executable content; a validated skill still needs tool permissions.

| Threat | Prevent | Detect | Contain | Recover | Status |
|---|---|---|---|---|---|
| Prompt injection via evidence/question | `buildPerspectivePrompt` quotes external text in fenced, length-bounded blocks, strips control chars, neutralises fences; builder is pure (no tools/policy handles) | adversarial test `expert-perspective-security.test.ts` | model output validated: only allowed refs survive | re-run with evidence excluded | PROVEN (structural) |
| Tool-use / approval manipulation from content | perspectives have no tool access; lifecycle transitions require an authenticated actor; `ingestion|system|swarm|autopilot*` actors cannot APPROVE/ACTIVATE | audit_events per transition | fail closed on guard violation | revoke → REVOKED, history kept | PROVEN (guards tested) |
| Research poisoning / fake provenance | evidence ids are deterministic hashes of canonical origin; claims and capabilities require refs that exist for that expert | `EXPERT_CLAIM_EVIDENCE_UNKNOWN`, `EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT` | affected experts go STALE on retraction (`markEvidence`) | re-derive from remaining evidence | PROVEN |
| Citation laundering / source monoculture | `source_family` + `canonical_origin`; `source_independence` counts distinct families per claim | claim rows expose independence | resolver can weight by independence (D2) | – | PARTIALLY_PROVEN (stored, not yet weighted) |
| Identity collision / spoofing | `identity_confidence` threshold 0.8, AMBIGUOUS fails closed, no auto-merge | I03 test | cannot advance | resolver re-run with more evidence | PROVEN |
| Signature-only expertise (Pacing seed) | `signature` and `secondary` evidence kinds can never support a capability | I01 test | – | – | PROVEN |
| False authority / celebrity bias | ranking will exclude fame features; adversarial ranking test | planned D2 | – | – | NOT_PROVEN (resolver pending) |
| Hallucinated attribution / sycophancy | output validator drops claims with unknown refs; first-person expert voice rejected | `dropped_claims`, `dropped_refs` reported | claims without refs never persist (CHECK non-empty) | – | PROVEN |
| Expert collusion / premature convergence | independent perspectives before synthesis (§16) | planned D3 | – | – | NOT_PROVEN |
| Knowledge-store poisoning / approval bypass | swarm output only ever lands as `review_required` + `blocked_pending_human`; heuristic judge cannot say VERIFIED_FOR_USE | `expert-swarm-verification.test.ts` | human review queue | reject candidate | PROVEN |
| Self-approval | approver must differ from last CHECKED actor (I06) | I06 test | – | – | PROVEN |
| Retracted research | evidence lifecycle + propagation to STALE | §31 test | – | re-check | PROVEN |
| Privilege escalation via expert data | expert tables carry no credentials, no agent ids, no tool grants | schema review | – | – | PROVEN (by construction) |
| Supply-chain (adapters fetching the web) | existing adapter cache + rate limits; ingestion respects robots (E1) | planned | – | – | NOT_PROVEN |
| Data over-collection | schema stores only professional identity, affiliations, public evidence (§27) | schema review | – | – | PROVEN (by construction) |
