# =============================================================================
# Djimitflo Dockerfile — Multi-stage production build
# =============================================================================
# Build stages:
#   1. deps    — install all dependencies (including dev for build tools)
#   2. builder — build shared, server, and dashboard
#   3. runner  — minimal production image with only runtime artifacts
# =============================================================================

# --- Stage 1: Install dependencies ---
FROM node:20-bookworm AS deps

WORKDIR /app

# Copy package manifests and root config
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source for workspace resolution
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/dashboard/ packages/dashboard/

# --- Stage 2: Build ---
FROM deps AS builder

WORKDIR /app

# Build shared package first (server and dashboard depend on it)
RUN npm run build --workspace=@djimitflo/shared

# Build server
RUN npm run build --workspace=@djimitflo/server

# Build dashboard with production API base
ENV VITE_API_BASE=/api
RUN npm run build --workspace=@djimitflo/dashboard

# Prune devDependencies for production
RUN npm prune --production

# Verify runtime-critical dependencies resolve after prune
RUN node -e "require('better-sqlite3'); require('@djimitflo/shared')"

# --- Stage 3: Production runtime ---
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Create non-root user
RUN groupadd -g 1001 djimitflo && \
    useradd -u 1001 -g djimitflo -m -s /bin/bash djimitflo

# Create data directory for SQLite
RUN mkdir -p /data && chown djimitflo:djimitflo /data

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy server build output
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json

# Copy shared build output (server imports it)
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

# Copy dashboard build output
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist

# Copy root package files for workspace resolution
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Verify runtime-critical dependencies in final image
RUN node -e "require('better-sqlite3'); require('@djimitflo/shared')"

# Copy entrypoint
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DB_PATH=/data/djimitflo.sqlite
ENV DASHBOARD_PATH=/app/packages/dashboard/dist

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Switch to non-root user
USER djimitflo

# Volumes
VOLUME /data

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]