# Contributing to DjimFlo

Welcome! DjimFlo is a self-evolving agentic OS. We welcome contributions that make it smarter, safer, and more capable.

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
- **Test every service** — ≥15 tests per new service

## Testing

```bash
npm test                 # all workspaces
npx vitest run           # server workspace only
```

All tests must pass before submitting a PR. Type-check and lint must be clean.

## Commit Conventions

```
feat: add Thompson Sampling bandit for runtime selection
fix: resolve calibration drift in Self-Model service
docs: update README with Level-13 capabilities
chore: remove stale agent/loop branches
```

## Pull Request Process

1. Fork the repo, create a feature branch
2. Implement + test (≥15 tests per service)
3. Run `npm run type-check && npm run lint && npm test`
4. Open PR with description of what and why
5. CI must pass (type-check, lint, build, test)
6. Review by @dlandman

## Architecture Quick Reference

| Layer | Location | Purpose |
|-------|----------|---------|
| Orchestration | `loop-service.ts`, `loop-daemon.ts` | Goal execution |
| Intelligence | `expert-swarm-orchestrator.ts`, `judge-service.ts` | Knowledge + evaluation |
| Self-Improvement | `service-refactoring-analyzer.ts`, `rsi-safety-guard.ts` | RSI Engine |
| Safety | `rsi-safety-guard.ts`, `epistemic-gate-service.ts` | Governance |
| Execution | `execution/executors/*.ts` | Runtime executors |

## OpenSpec Changes

For material changes (new features, architecture changes), create an OpenSpec change:

```
openspec/changes/<change-name>/
├── proposal.md
├── design.md
├── tasks.md
└── specs/<change-name>/spec.md
```

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions will be licensed under the MIT License.
