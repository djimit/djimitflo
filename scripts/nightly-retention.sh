#!/usr/bin/env bash
# nightly-retention.sh — count-only retention report for the production DB (M2e, 2026-10-29).
#
# The host copy at /srv/djimitflo/nightly-retention.sh (cron `20 4 1 * *`) opened /data/djimitflo.sqlite read-write in a
# second process and DELETEd openmythos_eval_runs older than 180 days — a write outside the app (A25). The app is the only
# writer; in-app purging is the RETENTION_ENABLED scheduler (retention-service.ts). This replacement opens the DB read-only
# and only prints how many rows are past the horizon, so the operator can decide on an in-app rule.
#
# Install from origin/main (never from a scratch worktree):  install -m 755 scripts/nightly-retention.sh /srv/djimitflo/
set -euo pipefail
CONTAINER="${DJIMITFLO_CONTAINER:-djimitflo-live}"
DAYS="${RETENTION_REPORT_DAYS:-180}"
case "$DAYS" in ''|*[!0-9]*) echo "RETENTION_REPORT_DAYS must be an integer" >&2; exit 2 ;; esac
docker exec -e NODE_PATH=/app/node_modules -e DAYS="$DAYS" "$CONTAINER" node -e "
const D = require('better-sqlite3'); const db = new D('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
const cutoff = new Date(Date.now() - Number(process.env.DAYS) * 86400000).toISOString();
const n = (sql) => { try { return db.prepare(sql).get(cutoff).n; } catch (e) { return 'error: ' + e.message; } };
console.log(JSON.stringify({ at: new Date().toISOString(), days: Number(process.env.DAYS), cutoff,
  openmythos_eval_runs_older: n('SELECT COUNT(*) AS n FROM openmythos_eval_runs WHERE started_at < ?') }));
"
