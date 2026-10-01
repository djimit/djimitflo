# Runtime admission: threat model

| Threat | Mitigation in this change | Residual |
|---|---|---|
| A new executor kind runs because it is registered | RA-01/RA-02: no record, no dispatch (`UNKNOWN_RUNTIME`) | — |
| A runtime attests itself (task metadata, output, logs) | Records come only from the repo ledger; `assessed_by == runtime_id` is REJECT; a PASS without evidence refs counts as NOT_PROVEN; the test puts `runtime_admission: ADMIT` in task metadata and is still denied | A reviewer could merge a false record: PR review is the control |
| Version or binary swap after assessment | The pinned version is checked against Djimitflo's own post-boot probe; drift is denied; the record hash names the exact record | Legacy records with `runtime_version: null` (7 runtimes) are not version-bound until migrated; the probe reads `--version` (a swapped binary could lie: G8 checksum pins only exist for atomic) |
| Stale probe row after an image change gives a false deny or allow | Only probe rows written after this process started are trusted | — |
| A fallback chain reaches an unadmitted runtime | Admission is re-checked on every attempt (RA-15) | — |
| A critical failure is outweighed by good scores | No scoring: critical FAILs are absolute (RA-04) | — |
| A runtime claims approval, memory, task or promotion authority | Any RUNTIME/SHARED authority is REJECT; UNKNOWN is HOLD (RA-06) | Declared by the assessor, not detected at runtime |
| Hidden child agents | RUNTIME_INTERNAL or UNKNOWN children block ADMIT (RA-10); Djimitflo-visible children stay under NestedSpawnService budgets | opencode runs with internal subagents as LEGACY_ADMITTED; bounded only by its token brake and wall timeout |
| Broader filesystem, network or MCP scope | Containment is a gate; a widened scope means a new assessment | **Network egress of CLI child processes is not scoped for any runtime today** |
| Admission expires silently and stops all work | Stall warning 30 days ahead; the denial event names the expiry | An operator must act before 2026-12-31 |
| The rollback switch is abused | `RUNTIME_ADMISSION_MODE=shadow` is operator-only config (runtime.env), logs every would-be denial at WARNING | Same trust level as every other runtime.env flag |
| Admission decisions cannot be audited | Every decision is an `execution_events` row with the record hash | — |
