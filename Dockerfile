# =============================================================================
# Djimitflo Dockerfile — Multi-stage production build
# =============================================================================
# Build locally first: npm run build (all workspaces)
# Then docker build — dist/ folders are included in context
# =============================================================================

FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Create non-root user
RUN groupadd -g 1001 djimitflo && \
    useradd -u 1001 -g djimitflo -m -s /bin/bash djimitflo

# Create data directory for SQLite
RUN mkdir -p /data && chown djimitflo:djimitflo /data

# Copy package manifests and root lockfile
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/telegram/package.json packages/telegram/

# Install all dependencies (including dev for native modules like better-sqlite3)
# Replace workspace:* with * for npm compatibility
RUN sed -i 's/"workspace:\*"/"*"/g' packages/server/package.json packages/dashboard/package.json packages/telegram/package.json; \
    npm install

# Copy pre-built dist directories
COPY packages/shared/dist packages/shared/dist
COPY packages/shared/src packages/shared/src
COPY packages/shared/package.json packages/shared/
COPY packages/telegram/dist packages/telegram/dist
COPY packages/telegram/src packages/telegram/src
COPY packages/telegram/package.json packages/telegram/
COPY packages/server/dist packages/server/dist
COPY packages/server/src packages/server/src
COPY packages/server/package.json packages/server/
COPY packages/dashboard/dist packages/dashboard/dist

# Copy entrypoint
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Create writable directories for the djimitflo user and make /app writable
RUN mkdir -p /app/packages/knowledge/skills /app/packages/knowledge/context /app/packages/knowledge/memory \
    /app/packages/reports/validation /app/packages/reports /data/backups && \
    chown -R djimitflo:djimitflo /app /data

# Environment defaults
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DB_PATH=/data/djimitflo.sqlite
ENV DASHBOARD_PATH=/app/packages/dashboard/dist
ENV BACKUP_DIR=/data/backups

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