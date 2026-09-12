# G139 proof-run detail UI verification

The previously unevidenced `/swarm-mission-control/proof-runs/:proofRunId` dashboard route now has a regression covering successful load, rollback state refresh, failed lookup and accessible alert semantics. Dashboard passes **151/151** tests; full workspace passes **2744/20 skipped**, server remains **2455/20 skipped**, `/loops` **12/12**, build/type-check/lint and capability graph checks pass. No provider or deployment mutation was performed.
