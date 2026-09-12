# G211 agent-catalog workspace-root repair

The server agent-catalog singleton now resolves its default SQLite path through the shared monorepo root resolver. A server launched from `packages/server` therefore uses `<monorepo>/.data/agent-catalog.sqlite`, while `AGENT_CATALOG_DB` remains an explicit override. Two focused path regressions pass, followed by full server/workspace and `/loops` validation.
