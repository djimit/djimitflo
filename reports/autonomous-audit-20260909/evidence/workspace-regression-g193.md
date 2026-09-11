# G193 — post-root-resolution workspace regression

Date: 2026-09-10

Command: `npm test -- --run`

Result: exit 0; **2772 passed / 20 skipped / 0 failed**.

- server: 2483 passed, 20 skipped
- dashboard: 151 passed
- MCP: 39 passed
- catalog: 26 passed
- ransomware: 40 passed
- shared: 3 passed
- Telegram: 30 passed

This run follows the self-modification workspace-root repair and the new SBOM/self-modification HTTP coverage. The known fixture `fatal: not a git repository` diagnostic remains non-failing and no external system was touched.
