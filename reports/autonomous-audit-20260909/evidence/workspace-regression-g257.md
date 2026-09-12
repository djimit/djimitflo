# G257 workspace regression

The immediate `npm test -- --run` rerun completed successfully across all workspaces: agent-catalog 26, dashboard 151, MCP 41, ransomware 40, server 2,514/20 skipped, shared 3, Telegram 30; 0 failed. A preceding parallel run exposed one task-recovery 404 (`TASK_RUNNING` expected) that passed isolated and immediate repeated server/workspace execution; it remains an UNKNOWN test-environment intermittent.
