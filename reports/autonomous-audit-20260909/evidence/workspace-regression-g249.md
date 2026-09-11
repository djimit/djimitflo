# G249 integrated workspace regression

`npm test` completed from the audit checkout after KnowledgeBus validation.
Package totals: agent-catalog 26, dashboard 151, MCP 41, ransomware 40,
server 2,509 (20 skipped), shared 3, Telegram 30 — **2,800 passed / 20
skipped / 0 failed**. The server fixture emits one expected non-Git diagnostic
while testing an isolated non-repository path; the Vitest summaries remain
green.
