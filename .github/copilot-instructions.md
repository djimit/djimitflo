# Copilot Instructions — djimitflo

> See root `.github/copilot-instructions.md` for global conventions.

Codex-native agent orchestration control plane. Monorepo with server and dashboard workspaces.

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

Monorepo (`npm workspaces`). Uses `ws` for WebSocket communication. Server and dashboard are separate workspaces.

```
packages/server/
├── package.json          # @djimitflo/server workspace
└── src/                  # Server source

packages/dashboard/
├── package.json          # @djimitflo/dashboard workspace
└── src/                  # Dashboard source (React + Vite)

packages/shared/
├── package.json          # @djimitflo/shared workspace
└── src/                  # Shared utilities
```

## Key Details

- **TypeScript strict mode** throughout.
- **ESM modules** — `"type": "module"` in package.json.
- **Vite** for dashboard bundling.
- **Vitest** for testing.
- **Workspace dependencies** managed via npm workspaces (requires npm >= 9).
