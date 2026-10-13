# NE-010 — MiroFish (LLM social simulation) as a prediction or evolution substrate

| Field | Value |
|---|---|
| Repository | https://github.com/666ghj/MiroFish |
| Reviewed commit | `7657031ac01184afe2cb220f5ee3545573b5e843` (2026-10-02) |
| Review date | 2026-10-12 |
| Method | Source read only: shallow clone, files read, clone deleted. Nothing was installed, built or run. |
| Licence | AGPL-3.0 |
| Pinned dependencies | 185 packages in `uv.lock`, including camel-oasis 0.2.5, camel-ai 0.2.78, zep-cloud 3.25.0 |
| Reviewer | Claude (Djimitflo operator session), read-only review |
| Decision | Operator, 2026-10-12: REJECT, documentation only |

## What it is in code

A Flask wrapper around CAMEL-AI's OASIS Twitter/Reddit simulator:

1. Uploaded seed documents become an entity graph in Zep Cloud (LLM extraction).
2. An LLM writes a persona for each entity.
3. All agents, served by one shared model, post, like, repost, follow and comment in rounds (`backend/scripts/run_parallel_simulation.py:177-201`, `:1034`, `:1270`).
4. A report agent writes a narrative "prediction" from the graph.

Nothing is selected, mutated or retained between runs.

## Findings

Confidence: **verified** = read directly in the source at the reviewed commit; **limitation** = a design property, not a bug;
**untested** = not measured in this review and not claimed either way.

| # | Finding | Class | Confidence | Source |
|---|---|---|---|---|
| A | No empirical outcome validation: no accuracy, calibration, backtest or ground-truth comparison exists; tests cover parsing and Zep contracts only. Narratives are not evidence of predictive performance. | verified defect | high | test tree; no evaluation module |
| B | Provenance contamination: simulated posts are written into the same Zep graph as the observed seed facts, deliberately without an in-text simulation marker; the report agent retrieves from the blended graph. | verified defect | high | `services/zep_graph_memory_updater.py:40-41, 494-500` |
| C | Security: Flask binds `0.0.0.0`, `CORS(origins="*")`, no API authentication, default `SECRET_KEY='mirofish-secret-key'`, 50 MB uploads straight into prompts without injection screening. | verified defect | high | `backend/run.py:39`, `app/__init__.py:43`, `app/config.py:21, 36` |
| D | No evolutionary mechanism: no selection, retention or improvement across runs. | limitation | high | whole pipeline |
| E | No demonstrated bottleneck reduction for Djimitflo, whose limiting stage is verified → merged → settled; a simulation layer adds candidates and narrative, not settled evidence. | limitation | high | integrated report 2026-10-12 |
| F | Agents are not independent: one shared model; persona fields `sentiment_bias`, `influence_weight`, `response_delay`, `stance` are generated but never read by the simulation. | verified defect | high | `services/simulation_config_generator.py:61-81, 872`; `services/oasis_profile_generator.py:86-118` |
| G | Not reproducible: unseeded `random`, temperatures 0.3–0.7, Docker image `:latest`, external non-deterministic extraction. | verified defect | high | `run_parallel_simulation.py:1040-1090`; `utils/llm_client.py:134, 162`; `docker-compose.yml` |
| H | AGPL-3.0: network use of a modified version obliges source publication; requires a separate legal and architectural assessment before any integration. A constraint, not proof of technical inferiority. | constraint | high | `LICENSE` |
| I | Whether the simulated social dynamics show useful emergent behaviour or predictive skill. | untested hypothesis | — | not measured; no claim either way |

No fabricated benchmark results were found (unlike NE-007/ruvnet); the README overclaims in prose, not in code.

## Threat scenarios (if it were run as shipped)

- An unauthenticated network client reads or drives simulations and uploads (C).
- A seed document carries a prompt injection into persona and report prompts (C).
- Simulated chatter is retrieved as fact and enters a decision or the knowledge base (B).
- Seed data leaves the host to Zep Cloud and the LLM provider (external services).

## Invariant

**SIMULATED ≠ OBSERVED ≠ VERIFIED.** Simulation output is never promoted into DjimitWiki, production memory or the verified
knowledge graph as factual evidence. Any future simulation capability needs explicit provenance, source classification,
isolation and independent verification.

## Reopen conditions

A new implementation or independently verified evidence that shows **all** of: (A) a pre-registered evaluation; (B) comparison
against simple statistical and historical baselines; (C) independent real-world outcome validation; (D) strict separation of
simulated, inferred and observed information; (E) reproducible experiments with protected holdout data; (F) security controls for
authentication, authorisation, secrets and isolation; (G) a measurable benefit over existing Djimitflo capabilities; (H) acceptable
licensing and operational cost. Meeting them permits a new evaluation, not adoption.

Research into multi-agent simulation in general is **not** prohibited; this entry covers the reviewed implementation and the
specific uses above.

## Reproduction

`git clone https://github.com/666ghj/MiroFish && git -C MiroFish checkout 7657031ac01184afe2cb220f5ee3545573b5e843`, then read the
files cited above. Do not install or run it outside an isolated sandbox approved by the operator.
