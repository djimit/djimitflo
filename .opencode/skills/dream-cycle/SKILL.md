---
name: dream-cycle
description: Run the Djimit dream cycle — scout external developments (papers, releases, publications), shape them into capability-aware proposals, and push approved improvements as governed LoopDaemon goals. Use when asked to scout developments, propose improvements, or evaluate the ecosystem against external state of the art.
---

# Dream Cycle — gecontroleerde verbeteringen uit externe signalen

## De cyclus

```
retrospective (leer)  ->  dream-scout (signalen scoren)
                                  | proposals/*.json
                                  v
                          dream-architect (plannen + capability-
                          matrix + human-gate voor risk)
                                  | plans/*.plan.json
                                  v
                          dream-implementer
                          (LoopDaemon-goals, maker/checker,
                          authority-approval vereist)
                                  |
                                  v
                          evidence in authority ledger
                                  |
                                  ---> volgende retrospective
```

## Fasen

| Fase | Commando | Agent | Output |
|---|---|---|---|
| Scout | `dream_cycle.py --phase scout` | dream-scout | `signals-<WW>.json` + proposals/*.json |
| Architect | `dream_cycle.py --phase architect` | dream-architect | plans/*.plan.json (verdict GO/HOLD/REJECT) |
| Implement | LoopDaemon goals | dream-implementer | DEPLOYED/BLOCKED events |
| Status | `dream_cycle.py --phase status` | - | dream-event-overzicht |

## OpenMythos-koppeling

1. Dream-architect checkt proposals tegen OpenMythos-cases — als een
   proposal een capability raakt die al een eval-case heeft, moet het
   plan een case-update bevatten (`openmythos_case_results`).
2. Nieuwe capabilities zonder case krijgen een nieuwe case-id in de
   `openmythos_eval`-tabel.
3. Certificerings-niveau: een "droom" passeert dezelfde 275-case
   benchmark als andere governed loops.

## Governance-rails (niet-omzeilbaar)

- Elk signaal, plan en implementatie is een LifecycleEvent
  (actor `dream-*`).
- Plans met `requires_human: true` gaan via de normale
  `approval_ledger`-flow — de agent omzeilt nooit gate 4.
- Qdrant/knowledge-dedupe voor proposeren: geen dubbele verbeteringen.
- Cap per cyclus: 5 proposals, 3 plans.

## Bronnen

- arXiv cs.AI/cs.SE/cs.CR (Atom-API, vocab-gefilterd)
- GitHub release-radar voor de dependency-graph repos
- Djimit2 week-posts (reasoning-node claim-voeden)
- Authority retrospective (waar heeft de pipeline pijn?)
- Knowledge MCP + Qdrant dedupe