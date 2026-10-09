# Cognitive runtime — forensic baseline (Phase CR, step 1)

Code: origin/main `3eebe3bb` (2026-10-09). Prod: read-only SQLite queries in `djimitflo-live`, last 30 days unless noted.
Classes: IMPLEMENTED (code + prod evidence), PARTIAL, DECLARED_ONLY, DEAD_CODE, MISSING, UNKNOWN. Nothing was changed to produce this.

## The one-paragraph answer

DjimitFlo today is a governed **maker/checker pipeline** with a strong executed verifier (tests, mutation, deterministic gates) and a
human merge. That pipeline is the only path that ships verified change (41 draft PRs, 22 merged by the operator). Almost everything the
instruction asks for exists as a table, route or service, but most of it is **declared, dormant or written-only**: no consumer reads it,
and several pieces are silently broken. The first work is therefore not new architecture, but (a) fixing verified defects that corrupt
evidence, (b) falsifying the assumptions the instruction rests on (that reviewers, memory and diversity add value), and (c) deleting or
parking what has no consumer.

## Baseline map

| Area | Class | Key evidence |
| --- | --- | --- |
| Agent registry (`agents`) | PARTIAL | 28 rows all `active` by declaration; 8 without heartbeat (hermes-macmini/-workstation since 07-14) |
| Capability representation / DAPS | DECLARED_ONLY | self-declared strings; `swarm_capabilities` incl. fixture rows (eval 0.95, n_runs 0); DAPS observe-only |
| Event bus | IMPLEMENTED (publish) / IMPLEMENTED unauthenticated (ingest) | outbox 1,675 published; ingest by prefix allow-list, `source` unsigned |
| Tokens | IMPLEMENTED (HMAC bearer) | one secret (falls back to JWT_SECRET), no jti/nonce/revocation |
| Key-signature agent identity | MISSING | Ed25519 only for deep-agent contracts and plugin manifests |
| Heartbeat endpoint | PARTIAL, weak | any `write:evidence` principal can heartbeat any agent id (`routes/agents.ts:210-231`) |
| Leases | IMPLEMENTED (work allocation only) | 2,688 maker/checker leases; no Commons lease concept |
| Sub-agent delegation | PARTIAL, dormant | `SPAWN_DEPTH_BUDGET=0`; last spawns June; 8 stuck `prepared` |
| Runtimes | OpenCode IMPLEMENTED; remote IMPLEMENTED (flaky); Atomic executor PARTIAL (0/16); Hermes PARTIAL; OpenClaw, Overwatch DECLARED_ONLY | leases + agent rows |
| **Lure funnel** | **broken at delivery** | 28 lures → 340 invitee slots → 171 invites → **0 delivered** (token poller only claims `social.question/response`, `agent-communication-service.ts:544`); bite is derived, not stored, not causal (the one bite = opencode-control's own scheduler); probes 0 |
| Failure reasons | collapsed | expired/rejected/wrong-agent/invalid token → `token_invalid`; undelivered/unanswered → `expired`; lease, subscription, replay not representable |
| Resident provenance | wrong | no token, but stamped `signed_runtime_poller` (`agent-communication-service.ts:533`) |
| Approvals / policy | IMPLEMENTED | 312 approvals (110 human, 194 auto); `protected_paths`/`allowed_tools` stored, never enforced; `policy_violations` never written |
| Oracle-lane auto-approve | IMPLEMENTED (acting) | overrides rule-v1 "no" (class with 42 V / 48 R still approved) |
| Earned autonomy U1 | DECLARED_ONLY (display) | gates nothing |
| **Authority ledger** | **PARTIAL, data defect** | all 194 `autonomy:*` approvals recorded `actor_type='human'` (`approval-service.ts:142`); 620/783 events without evidence refs |
| Tool routing / least privilege | DEAD_CODE (tool broker, test-only) / DECLARED_ONLY (MCP perms) / MISSING (per-agent allow-lists) | opencode reviewers read-only only by post-hoc `git status` |
| Model routing | bandit IMPLEMENTED (acting, maker species only); selector MS-1 shadow; fitness view shadow | 210 bandit decisions |
| Swarm/orchestration | panel IMPLEMENTED but 90 % `needs_evidence` and skipped by shipping lanes; council DEAD (every 3-model session failed); committee IMPLEMENTED (shadow); expert swarm PARTIAL; swarm sessions DEAD (throws); consensus/discussions DEAD | counts per service |
| Model diversity / correlation | reviewer independence DECLARED_ONLY; correlation MISSING | — |
| Evaluation | gym IMPLEMENTED (775 runs); genome trials 0 decisive; judge calibration 95 rows all `actual_outcome` NULL; SEGML 290/290 failed | — |
| GraphStore | DECLARED_ONLY | no client, no table |
| Qdrant | PARTIAL, broken | swarm collection 384-dim queried with 768-dim → `[]` silently; experience collection missing; 0/746 tasks got a context snapshot |
| KB (DjimitKBWiki) | IMPLEMENTED | 1,313 pages; 52/65 retrievals top-hit the same 3 pages; 462 pages with content_safety `error` still served |
| Memory (engineering rules) | IMPLEMENTED | 21 read rules, **none with fitness > 0**; holdout since 10-08: rules 2 V/10 R vs holdout 4 V/3 R; all-time rules 52 V/81 R |
| Memory layers | PARTIAL | episodic 99, procedural 51, semantic 2, working 0, collaborative absent |
| Claims / epistemic graph | DECLARED_ONLY | 1,954 expert claims, 99.9 % `undetermined`; 1 claim relation |
| Trust states (UNTRUSTED…REVOKED) | MISSING | no lifecycle |
| Skills | PARTIAL | SKILL.md prompt text; `agent_skills` 0; `skill_content_hash` NULL |
| Knowledge gaps | PARTIAL, idle | curiosity has no scheduler/ordering; last claim 09-13; `knowledge_gaps` 0 rows |
| Context construction | PARTIAL, unmeasured | three separate mechanisms; only holdout arms measure anything |
| Semantic Fidelity Checksum | parked proposal only | `cb2d05e7` needs_grounding, targets the non-existent GraphStore |
| Provenance through transformations | PARTIAL | single-step hashes; no lineage |
| Collaboration measurement | MISSING | nothing measures pairs/teams/topologies |
| Self-improvement net effect | PARTIAL | 45 verified vs 52 regressed (30 d); learning closures Δ +0.001 |

## Falsification table (instruction §27, points 1–6)

| # | Proposal (instruction §) | Problem / evidence | Existing part | Smallest falsifying experiment | Expected gain | New failure modes |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Reviewers add value (§10, §22) | checker accepts 96 % vs operator merges 54 %; panel 90 % `needs_evidence` | checker, panel, gym mutant holdout | blind-feed 20 known-defective + 20 merged diffs to the prod checker prompt; **fails if accept on defective ≥ 50 % or AUC < 0.65** (~40 checker calls) | know whether to keep, fix or cut the checker | cost of 40 calls |
| F2 | Diversity beats count (§9, §10, §14) | no correlation/synergy metric; council dead | reviewer-independence, honest-numbers kappa, X1 randomiser | randomise checker same-family vs cross-family on 30 goals; **fails if Δkappa CI includes 0** | first `model_correlation` datapoint | routing complexity |
| F3 | Memory rules help (§13) | no rule has fitness > 0; holdout 2/12 vs 4/7 | M5 + `MEMORY_HOLDOUT_RATE=0.3` | let arms reach ≥ 30 settled each, Fisher stratified by lane; zero-cost first: refit M5 excluding non-maker failures (#707); **fails if rules arm ≥ holdout** | stop injecting harmful rules | none |
| F4 | KB context helps panels (§19) | top hit collapsed onto 3 pages | `kbContext`, `kb_retrieval` | count `kb:` citations in panel outputs; then KB holdout on ~40 panels; **fails if citations ≈ 0 or no arm difference** | remove decorative context, save tokens | none |
| F5 | Vector layer is live (§15) | dimension mismatch, missing collection | context-injection, experience retrieval | one swarm search exactly as the code does; count tasks with `qdrant_swarm` source; **fails if 200 + ≥ 1 hit** | decide fix vs delete | none |
| F6 | Lures can measure presence (§2) | 0/171 invites delivered | lure service, social runtime | in the commons-runtime-proof harness cast a lure and poll with a valid token; **fails if the invite is returned** | a working L0 presence probe | none |
| F7 | Capability graph routing (§4, §6) | capabilities declared, not measured; bandit only on maker species | skill_outcomes, bandit, fitness view | only after F1/F2: route by measured capability on one lane in shadow; fails if shadow choice ≠ better outcome | — | premature without F1/F2 |
| F8 | Agent factory, sub-agents, topologies, evolutionary swarms (§7–§9, §23) | no verified signal that any multi-agent path beats the single maker+checker | committee arena, genome trials, effort controller | defer until F1/F2 show reviewer or diversity value; gate on a paired experiment against today's pipeline | — | large orchestration cost (Effort Paradox) |

## Verified defects (no experiment needed — already falsified)

1. `approval-service.ts:142` records `autonomy:*` approvers as human → evidence chain wrong for 194 approvals.
2. `social.invite` cannot be delivered over the token path → lure funnel structurally 0.
3. Lure "bite" is derived from the latest heartbeat, not stored, not causal; `status()` shows only 20 lures.
4. Residents stamped `signed_runtime_poller` without a token.
5. `/agents/:id/heartbeat` accepts any `write:evidence` principal for any agent id.
6. Token validation returns a boolean → all identity failures collapse to `token_invalid`.
7. Qdrant swarm query dimension mismatch fails silently (`[]`).
8. KB pages with content_safety `error` are served.

## Order of work

1. **Fix defects 1–6** in one PR (evidence and identity correctness; tests first). Defects 7–8: decide after F5/F4.
2. **Run F3 (zero-cost refit), F4 (citation count), F5 (one probe)** — read-only, minutes.
3. **Run F1** (40 checker calls) — the decisive experiment for the whole swarm programme.
4. **F2 via the X1 randomiser** once F1 says reviewers can discriminate at all.
5. Only then F6–F8, each behind its own gate. Dead modules (council mode, swarm sessions, consensus, SEGML, tool broker) go to the W8 retirement review (operator).
