# Contributing to DjimFlo

Welcome! DjimFlo is an agent orchestration control plane. We welcome contributions that make it more reliable, safer, and easier to operate.

## Development Setup

```bash
git clone https://github.com/djimit/djimitflo.git
cd djimitflo
npm install
npm run build
npm run dev
```

## Code Style

- **TypeScript strict mode** — no `any`, no `@ts-ignore`
- **ESM modules** — `"type": "module"`
- **No comments** unless non-obvious (Ponytail principle)
- **Smallest change** that preserves the control-plane contract
- **Test every service** — red/green tests for new behavior

## Testing

```bash
npm test                 # all workspaces
npx vitest run           # current workspace
```

All tests must pass before submitting a PR. Type-check and lint must be clean.

## Commit Conventions

```
feat: add new executor for Claude Code
fix: resolve worktree cleanup race condition
docs: update API endpoint reference
chore: remove unused services
```

## Pull Request Process

1. Fork the repo, create a feature branch
2. Implement + test
3. Run `npm run type-check && npm run lint && npm test`
4. Open PR with description of what and why
5. CI must pass (type-check, lint, build, test)
6. Review by @dlandman

## Architecture Quick Reference

| Layer | Location | Purpose |
|-------|----------|---------|
| Orchestration | `loop-service.ts`, `loop-daemon.ts` | Goal execution |
| Intelligence | `swarm-intelligence-service.ts`, `judge-service.ts` | Knowledge + evaluation |
| Execution | `execution/executors/*.ts` | Runtime executors (9 runtimes) |
| Governance | `compliance-audit-service.ts`, `governance-guard-service.ts` | Audit + safety |
| Auth | `auth-service.ts`, `middleware/auth.ts` | JWT + RBAC |

## License

By contributing, you agree your contributions will be licensed under the MIT License.
