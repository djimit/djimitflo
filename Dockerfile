# =============================================================================
# Djimitflo Dockerfile — Reproducible multi-stage production build
# =============================================================================
# Build: docker build -t djimitflo:latest .
# Run:   docker run -p 3001:3001 -v djimitflo-data:/data djimitflo:latest
# =============================================================================

# Stage 1: Build all workspaces from source
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Copy all package manifests first (for layer caching)
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/telegram/package.json packages/telegram/
COPY packages/agent-catalog/package.json packages/agent-catalog/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/ransomware-module/package.json packages/ransomware-module/

# Install ALL dependencies (including dev) for building
RUN npm install

# Copy source code
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY packages/dashboard/src packages/dashboard/src
COPY packages/dashboard/index.html packages/dashboard/index.html
COPY packages/dashboard/vite.config.ts packages/dashboard/vite.config.ts
COPY packages/dashboard/tsconfig.json packages/dashboard/tsconfig.json
COPY packages/telegram/src packages/telegram/src
COPY packages/agent-catalog/src packages/agent-catalog/src
COPY packages/mcp-server/src packages/mcp-server/src
COPY packages/ransomware-module/src packages/ransomware-module/src

# Build all workspaces
RUN npm run build

# Stage 2: Production runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3-minimal && \
    rm -rf /var/lib/apt/lists/*

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
RUN npm install --omit=dev

# Copy built artifacts from builder stage
COPY --from=builder /build/packages/shared/dist packages/shared/dist
COPY --from=builder /build/packages/server/dist packages/server/dist
COPY --from=builder /build/packages/dashboard/dist packages/dashboard/dist
COPY --from=builder /build/packages/telegram/dist packages/telegram/dist
COPY --from=builder /build/packages/agent-catalog/dist packages/agent-catalog/dist
COPY --from=builder /build/packages/mcp-server/dist packages/mcp-server/dist

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

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

USER djimitflo

VOLUME /data

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
