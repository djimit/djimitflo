# G102 root workspace regression

After the SEGML Level 3 route repair and contract-inventory refresh, the root
workspace suite completed successfully:

```text
agent-catalog: 26 passed
dashboard: 149 passed
mcp-server: 39 passed
ransomware-module: 40 passed
server: 2432 passed / 20 skipped
shared: 3 passed
telegram: 30 passed
total: 2719 passed / 20 skipped; exit 0
```

The known non-Git diagnostic was emitted during server tests but did not fail
an assertion. `assurance:truth` was also rerun and remains fail-closed because
OpenMythos evaluation and live deployment identity gates are unavailable.
