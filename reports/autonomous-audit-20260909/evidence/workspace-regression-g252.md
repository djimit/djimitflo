# G252 workspace regression

The complete workspace command after the SEGML production-cycle repair passes
**2,803 tests / 20 skipped / 0 failed**:

- agent-catalog: 26
- dashboard: 151
- MCP server: 41
- ransomware module: 40
- server: 2,512
- shared: 3
- Telegram: 30

The disposable server fixture still emits one expected non-Git diagnostic;
the suite remains green.

The immediately preceding integrated run exposed one non-reproducible
`loop-service.test.ts` expectation (`expected 201, received 200`); the same
complete workspace command rerun passed with the totals above. The observation
is retained as UNKNOWN rather than treated as fixed.
