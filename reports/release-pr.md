Changelog (draft)

- feat: production Dockerfile with pre-built dist and .dockerignore fix
  - Simplified Dockerfile to use local pre-built dist (avoids complex multi-stage workspace build issues in Docker)
  - Include dashboard dist in build context
  - Make /app writable for djimitflo user
- feat: Telegram gateway improved
  - async non-blocking startup, graceful 409 handling
  - added AgentType overwatch and djimitnl
- fix: OKF indexing scripts
  - index_qdrant.py: QDRANT_API_KEY handling + OKF_BASE Path fix
  - rebuild_indexes.py: propagate env to tools

Commit messages:
- "feat: Telegram gateway - non-blocking startup, graceful 409 handling"
- "fix: index_qdrant.py - use Path for OKF_BASE and send Qdrant API key header"
- "chore: include dashboard dist in Docker context and simplify Dockerfile"

PR text:
This PR contains infra and reliability fixes necessary to run Djimitflo in the local workstation environment. Key changes:
- Docker: simplified production image that uses pre-built dashboard artifacts to avoid workspace installation issues inside Docker.
- Telegram: gateway rework to avoid server crashes when other processes poll the same bot tokens.
- OKF: indexing script fixes and rebuild flow improvements.

Push commands (run from repo root):
1. git add Dockerfile .dockerignore packages/telegram/src/index.ts packages/server/src/index.ts
2. git commit -m "infra: docker + telegram + okf indexing fixes"
3. git push origin HEAD:refs/heads/feature/infra-docker-telegram-okf

Checklist before PR ready:
- [ ] Verify no secrets in committed files (.env.docker excluded)
- [ ] Confirm Telegram tokens are not committed
- [ ] Smoke test on workstation: health, login, usage, workstation-urls, repositories
- [ ] Validate OKF MCP server and Qdrant indexing via rebuild_indexes.py
- [ ] Run workspace provisioner test with SSH keys available

