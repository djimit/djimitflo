#!/bin/bash
set -e

echo "========================================="
echo " Djimitflo Server"
echo " Version: $(node -e "console.log(require('/app/package.json').version)")"
echo "========================================="
echo ""

# Ensure data directory exists and is writable
if [ ! -d "/data" ]; then
  echo "Creating /data directory..."
  mkdir -p /data
fi

# Validate JWT_SECRET in production
if [ "$NODE_ENV" = "production" ] && [ -z "$JWT_SECRET" ]; then
  echo "FATAL: JWT_SECRET is required in production. Set it in your .env.docker file."
  exit 1
fi

# Print safe startup info
echo "Port: ${PORT:-3001}"
echo "Host: ${HOST:-0.0.0.0}"
echo "Database: ${DB_PATH:-/data/djimitflo.sqlite}"
echo "Dashboard: ${DASHBOARD_PATH:-/app/packages/dashboard/dist}"
echo ""

# Start the server
exec "$@"