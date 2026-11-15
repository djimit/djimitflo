# Proposals for reproduced defects not fixed in this session

Each is a finding in `findings.json`. Fixes below are the smallest known; none is built here (draft-PR budget used, or the change needs an operator decision).

| id | evidence | proposal | needs |
|---|---|---|---|
| D-S1-1 | E3 (S1) | A run whose only non-pass gate is the skipped security review is written goal `failed` / run `blocked`; write `ready_for_human_merge` (or `blocked` with reason `strict_completion_rule`) when the only problem is that rule; keep `failed` for a gate that fails or is unknown. loop-daemon.ts:945, :1055-1056. | operator: the strict completion rule itself is a recorded decision; only the label changes |
| D-S2-1 | E3 (S2) | `POST /api/swarms/spawns/root` on a terminal run → 409. nested-spawn-service.ts:168, loop-service.ts:1895. | — |
| D-S2-2 | E3 (S2) | A run with only prepared leases is shown `running`; set `running` when the first lease starts. loop-lifecycle-service.ts:134-135. | — |
| H1-H3 | E1+E2+E5 | Nested spawn: settle grants against measured use, cap the child's tokens/timeout at its grant, mirror lease status onto sub_agent_spawns (M0 fixes 3-4). Dormant in prod. | — |
| H4 | E1+E5 | Run makers under their own uid so they cannot read the server environment or write the control-plane database; wire one real tool-mediation choke point or retract the ToolBroker claim. Detail kept private. | operator: image + protected path (runtime-admission.ts) |
| H8 | E1+E5 | Carry `source: synthetic` from the repo-graph snapshot into the explainer text and evidence export, or suppress the synthetic graph; test that follows a synthetic row to the output. | — |
| H9 | E1+E2+E5 | A security finding closes only on a retest bound to the finding's commit/release; a DjimitSec `UNKNOWN` receipt is not `completed`. Check FINDING_FIX_AUTO_APPROVE / LOOP_AUTO_MERGE_FINDING_FIX inherit FR-004. | — |
