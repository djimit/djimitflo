# Copilot Instructions — djimitflo

> See root `.github/copilot-instructions.md` for global conventions.

Project rules live in [`AGENTS.md`](../AGENTS.md) (commands, protected paths, definition of done, review rules) and the
files it links: [`SOUL.md`](../SOUL.md) (doctrine and the Ponytail engineering style), [`USER.md`](../USER.md),
[`TOOLS.md`](../TOOLS.md), [`HEARTBEAT.md`](../HEARTBEAT.md). This file only adds Copilot-specific setup.

## Browser Testing

Playwright MCP is configured in `.vscode/mcp.json`. Install first:
```bash
npm install -g @playwright/mcp
```
