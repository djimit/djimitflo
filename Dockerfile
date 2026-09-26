# =============================================================================
# Djimitflo Dockerfile — Reproducible multi-stage production build
# =============================================================================
# Build: docker build -t djimitflo:latest .
# Run:   docker run -p 3001:3001 -v djimitflo-data:/data djimitflo:latest
# =============================================================================

# Stage 1: Build all workspaces from source
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# better-sqlite3 builds its native addon when no prebuilt binary is available.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy all package manifests first (for layer caching)
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/server/tsconfig.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/dashboard/tsconfig.json packages/dashboard/
COPY packages/telegram/package.json packages/telegram/
COPY packages/telegram/tsconfig.json packages/telegram/
COPY packages/agent-catalog/package.json packages/agent-catalog/
COPY packages/agent-catalog/tsconfig.json packages/agent-catalog/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/mcp-server/tsconfig.json packages/mcp-server/
COPY packages/ransomware-module/package.json packages/ransomware-module/
COPY packages/ransomware-module/tsconfig.json packages/ransomware-module/

# Install ALL dependencies (including dev) for building
RUN npm install

# Copy source code
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY packages/dashboard/src packages/dashboard/src
COPY packages/dashboard/index.html packages/dashboard/index.html
COPY packages/dashboard/vite.config.ts packages/dashboard/vite.config.ts
COPY packages/telegram/src packages/telegram/src
COPY packages/agent-catalog/src packages/agent-catalog/src
COPY packages/mcp-server/src packages/mcp-server/src
COPY packages/ransomware-module/src packages/ransomware-module/src

# Build all workspaces
RUN npm run build

# Stage 2: Production runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ARG VCS_REF=unknown
ARG BUILD_TIME=unknown
ARG BUILD_SOURCE=unknown

RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates git python3-minimal curl procps libatomic1 && \
    rm -rf /var/lib/apt/lists/*

# gh CLI: djimitflo's own PR review service shells out to it for PR
# comments and Check Runs (see GithubPrReviewService). Static .deb, no
# third-party apt repo needed; pinned like the other global installs below.
ARG GH_CLI_VERSION=2.100.0
RUN ARCH="$(dpkg --print-architecture)" && \
    curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${ARCH}.deb" && \
    dpkg -i /tmp/gh.deb && \
    rm -f /tmp/gh.deb && \
    gh --version

# Atomic Agent (plan C5): gym-only maker species via AtomicExecutor. Release tarball pinned by version + sha256.
ARG ATOMIC_AGENT_VERSION=0.6.5
ARG ATOMIC_AGENT_SHA256_X64=313ac01e1d40f3a6b39780c55af176bab231d2f03dea1d9b7e7bc93188a99f87
ARG ATOMIC_AGENT_SHA256_ARM64=be231b650c0293cfa4427aef32285403a72809ce882b09345b22400067409f18
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in amd64) A=x64; SUM="$ATOMIC_AGENT_SHA256_X64";; arm64) A=arm64; SUM="$ATOMIC_AGENT_SHA256_ARM64";; *) echo "unsupported arch $ARCH"; exit 1;; esac && \
    curl -fsSL -o /tmp/atomic.tgz "https://github.com/AtomicBot-ai/atomic-agent/releases/download/v${ATOMIC_AGENT_VERSION}/atomic-agent-linux-${A}.tar.gz" && \
    echo "${SUM}  /tmp/atomic.tgz" | sha256sum -c - && \
    mkdir -p /opt/atomic-agent && tar -xzf /tmp/atomic.tgz -C /opt/atomic-agent --strip-components=1 && rm -f /tmp/atomic.tgz && \
    ln -s /opt/atomic-agent/atomic-agent /usr/local/bin/atomic-agent && \
    atomic-agent --version

# Keep the production worker surface equal to the runtimes accepted by
# /swarms/runtime-readiness. Versions are pinned for reproducible probes.
RUN npm install --global @openai/codex@0.146.0 opencode-ai@1.18.10 @anthropic-ai/claude-code@2.1.282 && \
    git --version && codex --version && opencode --version && claude --version

# Create non-root user
RUN groupadd -g 1001 djimitflo && \
    useradd -u 1001 -g djimitflo -m -s /bin/bash djimitflo

RUN mkdir -p /data && chown djimitflo:djimitflo /data

# Copy package manifests
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/telegram/package.json packages/telegram/
COPY packages/agent-catalog/package.json packages/agent-catalog/
COPY packages/mcp-server/package.json packages/mcp-server/

# Install production dependencies only
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    npm install --omit=dev && \
    node -e "new (require('better-sqlite3'))(':memory:').close()" && \
    apt-get purge -y --auto-remove make g++ && \
    rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@12.0.2 && \
    npm install --global --prefix /tmp/npm-patches \
      brace-expansion@5.0.9 ip-address@10.3.1 tar@7.5.21 undici@7.29.0 && \
    cp -a /tmp/npm-patches/lib/node_modules/. /usr/local/lib/node_modules/npm/node_modules/ && \
    rm -rf /tmp/npm-patches

# Copy built artifacts from builder stage
COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/server/dist packages/server/dist
COPY --from=builder /build/packages/dashboard/dist packages/dashboard/dist
COPY --from=builder /build/packages/telegram/dist packages/telegram/dist
COPY --from=builder /build/packages/agent-catalog/dist packages/agent-catalog/dist
COPY packages/agent-catalog/src/schema packages/agent-catalog/dist/schema
COPY --from=builder /build/packages/mcp-server/dist packages/mcp-server/dist
COPY specs specs
# ExplainerCriticService reads packages/server/corpus/explainer.corpus.jsonl relative to dist; without it every explainer task fails with ENOENT.
COPY packages/server/corpus packages/server/corpus

# Copy entrypoint
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Create writable directories
RUN mkdir -p /app/packages/knowledge/skills /app/packages/knowledge/context /app/packages/knowledge/memory \
    /app/packages/reports/validation /app/packages/reports /data/backups && \
    chown -R djimitflo:djimitflo /app /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DB_PATH=/data/djimitflo.sqlite
ENV DASHBOARD_PATH=/app/packages/dashboard/dist
ENV BACKUP_DIR=/data/backups
ENV DJIMITFLO_COMMIT_SHA=$VCS_REF
# Baked-at-build provenance so /health can distinguish the running revision from
# the built artifact instead of trusting a runtime env that may be stale.
ENV DJIMITFLO_BUILD_COMMIT=$VCS_REF
ENV DJIMITFLO_BUILD_TIME=$BUILD_TIME
ENV DJIMITFLO_BUILD_SOURCE=$BUILD_SOURCE

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

USER djimitflo

VOLUME /data

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
