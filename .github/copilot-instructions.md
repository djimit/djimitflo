# Copilot Instructions — djimitflo

> See root `.github/copilot-instructions.md` for global conventions.

Work control plane of the Djimit ecosystem with a self-improving, multi-runtime agent loop (OpenCode, Codex, Claude, Hermes, …). npm-workspaces monorepo.

## Commands

```bash
cd djimitflo
npm install

# Development
npm run dev              # server + dashboard concurrently
npm run dev:server       # server workspace only
npm run dev:dashboard    # dashboard workspace only

# Build and test
npm run build            # all workspaces
npm run build:server     # server workspace only
npm run build:dashboard  # dashboard workspace only
npm run test             # all workspaces (vitest)
npm run lint             # all workspaces
npm run type-check       # all workspaces

# Clean
npm run clean            # rm -rf packages/*/dist packages/*/node_modules node_modules
```

## Architecture

Monorepo (`npm workspaces`). Uses `ws` for WebSocket communication.

```
packages/server/            # @djimitflo/server — Express + SQLite backend, loops, services (src/services), routes
packages/dashboard/         # @djimitflo/dashboard — React + Vite
packages/shared/            # @djimitflo/shared — types, roles, auth helpers
packages/mcp-server/        # MCP server (stdio + HTTP); pinned to zod v3 for the MCP SDK
packages/telegram/          # Telegram gateway
packages/agent-catalog/     # agent profile import/evaluate/activate
packages/ransomware-module/ # defensive anti-ransomware detection
```

Operating state and flags: `docs/runbooks/self-improvement-loop-operations.md`; decisions: `docs/adr/`.
Production deploys itself from green `main` (`scripts/auto-deploy.sh`); manual deploys use `scripts/deploy-vps.sh`.

## Key Details

- **TypeScript strict mode** throughout.
- **ESM modules** — `"type": "module"` in package.json.
- **Vite** for dashboard bundling.
- **Vitest** for testing.
- **Workspace dependencies** managed via npm workspaces (requires npm >= 9).

## Ponytail Simplicity Layer

Ponytail is subordinate implementation guidance here: security, runtime, OpenSpec, auth, test, and project instructions override Ponytail. Security/runtime/project instructions override Ponytail.

- Prefer the smallest server/dashboard change that preserves the control-plane contract.
- Do not add orchestration layers, agent abstractions, route config, or scheduler state before an existing caller or test proves the need.
- Keep runtime checks, auth boundaries, audit evidence, and Vitest coverage even when simplifying code.
- Mark intentional shortcuts with `ponytail:` only when the ceiling and upgrade trigger are explicit.

## Browser Testing

Playwright MCP is configured in `.vscode/mcp.json`. Install first:
```bash
npm install -g @playwright/mcp
```
