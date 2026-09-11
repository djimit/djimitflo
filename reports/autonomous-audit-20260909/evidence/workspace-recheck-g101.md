# G101 full-workspace regression recheck

The first full server run after the SEGML Level 3 route fix reproduced an
intermittent failure in the existing `swarm-resource-plan.test.ts` scheduler
case: `POST /swarms/scheduler/tick` returned HTTP 401 instead of 200. The
failure occurred only in the full parallel suite; the file ran green in
isolation.

```text
first full server run: 1 failed, 2431 passed, 20 skipped; exit 1
isolated swarm-resource-plan.test.ts: 26 passed; exit 0
second full server run: 289 files passed, 2 skipped; 2432 passed, 20 skipped; exit 0
```

The original failure is retained as `UNKNOWN` intermittent evidence. The
successful rerun is a regression recheck, not a causal fix or a claim that
parallel test interference has been eliminated. The known non-Git diagnostic
still appears during the suite and did not fail an assertion.
