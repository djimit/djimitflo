#!/usr/bin/env bash
# verify-fk-repair.sh — prove the dangling-FK repair (repairRenamedForeignKeyTargets in packages/server/src/database/
# migrate.ts) on a COPY of the production DB before it runs on the live one at the next deploy boot. Prod: swarm_tasks
# has FOREIGN KEY (assigned_lease_id) REFERENCES "worker_leases_old"(id), a table that no longer exists, so every insert
# fails with "no such table: main.worker_leases_old".
#
# Usage (on a docker host that has an image built from a commit that contains the repair):
#   bash scripts/verify-fk-repair.sh <image> <db-copy.sqlite>            # dry run: prints the plan, runs nothing
#   bash scripts/verify-fk-repair.sh <image> <db-copy.sqlite> --apply    # runs the check in a throwaway container
# --apply copies <db-copy.sqlite> into a fresh temp dir (the given file is never written) and starts ONE container from
# <image> (--rm, --network none, only that temp dir mounted, entrypoint node, never the live container or /data). In it:
# row counts per table + dangling FKs, then the real boot path (database/index.js initializeDatabase: schema +
# runMigrations), then row counts again (no table may lose rows), dangling FKs (must be none), foreign_key_check on the
# repaired tables, and an insert of a swarm mission + task (NULL lease, and a real lease when one exists) inside a
# transaction that is rolled back. Exit 0 PASS, 1 FAIL, 2 usage error; a docker failure keeps docker's exit code.
set -euo pipefail

IMAGE="" SRC="" APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) if [ -z "$IMAGE" ]; then IMAGE="$a"; elif [ -z "$SRC" ]; then SRC="$a"; else echo "unexpected argument: $a" >&2; exit 2; fi ;;
  esac
done
[ -n "$IMAGE" ] && [ -n "$SRC" ] || { echo "usage: $0 <image> <db-copy.sqlite> [--apply]" >&2; exit 2; }
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 2; }
# a live WAL database has a -wal next to it; a copy made with .backup() does not
[ -e "$SRC-wal" ] && { echo "$SRC has a -wal file: looks like a live database, pass a copy (see the PR body)" >&2; exit 2; }

# VERIFY_JS_BEGIN
read -r -d '' VERIFY_JS <<'JS' || true
const D = require('better-sqlite3');
const P = process.env.DB_PATH;
const q = (n) => `"${n.replace(/"/g, '""')}"`;
function snap() {
  const db = new D(P, { readonly: true, fileMustExist: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const counts = {};
  for (const t of tables) { try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n; } catch (e) { counts[t] = `error: ${e.message}`; } }
  const set = new Set(tables);
  const dangling = [];
  for (const t of tables) for (const fk of db.pragma(`foreign_key_list(${q(t)})`)) if (!set.has(fk.table)) dangling.push({ table: t, from: fk.from, to: fk.table });
  db.close();
  return { counts, dangling };
}
const watch = ['swarm_missions', 'swarm_tasks', 'swarm_decisions', 'worker_leases'];
const before = snap();
console.log('before: tables', Object.keys(before.counts).length, 'dangling FKs', JSON.stringify(before.dangling));
console.log('before: rows', JSON.stringify(Object.fromEntries(watch.map((t) => [t, before.counts[t]]))));
require('/app/packages/server/dist/database/index.js').initializeDatabase().close();
const after = snap();
console.log('after:  tables', Object.keys(after.counts).length, 'dangling FKs', JSON.stringify(after.dangling));
console.log('after:  rows', JSON.stringify(Object.fromEntries(watch.map((t) => [t, after.counts[t]]))));
let fail = 0;
for (const [t, n] of Object.entries(before.counts)) {
  const m = after.counts[t];
  if (typeof n !== 'number') continue;
  if (typeof m !== 'number' || m < n) { fail = 1; console.log(`FAIL rows: ${t} ${n} -> ${m}`); }
  else if (m !== n) console.log(`note: ${t} ${n} -> ${m} (rows added by migrations/seeds)`);
}
if (after.dangling.length) { fail = 1; console.log('FAIL: dangling FKs remain', JSON.stringify(after.dangling)); }
const db = new D(P, { fileMustExist: true });
db.pragma('foreign_keys = ON');
for (const t of new Set(before.dangling.map((d) => d.table))) {
  const v = db.pragma(`foreign_key_check(${q(t)})`);
  console.log(`foreign_key_check(${t}): ${v.length} violation(s)`);
  if (v.length) fail = 1;
}
console.log('foreign_key_check (whole DB, informational):', db.pragma('foreign_key_check').length, 'violation(s)');
db.exec('BEGIN');
try {
  db.prepare("INSERT INTO swarm_missions (id, title, risk_class, status) VALUES ('fk-verify-m', 'fk verify', 'low', 'observed')").run();
  db.prepare("INSERT INTO swarm_tasks (id, mission_id, title, status) VALUES ('fk-verify-t1', 'fk-verify-m', 'fk verify', 'planned')").run();
  const lease = db.prepare('SELECT id FROM worker_leases LIMIT 1').get();
  if (lease) db.prepare("INSERT INTO swarm_tasks (id, mission_id, title, status, assigned_lease_id) VALUES ('fk-verify-t2', 'fk-verify-m', 'fk verify', 'planned', ?)").run(lease.id);
  console.log(`insert test: ok (${lease ? 'NULL lease and a real lease' : 'NULL lease'}; rolled back)`);
} catch (e) { fail = 1; console.log('FAIL insert test:', e.message); } finally { db.exec('ROLLBACK'); db.close(); }
console.log(fail ? 'FAIL' : 'PASS: no rows lost, no dangling FK, swarm_tasks accepts inserts');
process.exit(fail);
JS
# VERIFY_JS_END

if [ "$APPLY" != 1 ]; then
  echo "dry run (nothing started, nothing copied). With --apply this would:"
  echo "  1. copy $SRC into a fresh temp dir (the given file is never written)"
  echo "  2. docker run --rm --network none --memory 1g -v <tempdir>:/verify --entrypoint node $IMAGE -e <verify script>"
  echo "     (before/after row counts, dangling FKs, initializeDatabase() = the boot migrations, FK check, rolled-back insert)"
  echo "  3. remove the temp dir"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fk-verify.XXXXXX")"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
cp "$SRC" "$WORK/djimitflo.sqlite"
chmod 777 "$WORK" && chmod 666 "$WORK/djimitflo.sqlite"   # the image runs as uid 1001
docker run --rm --network none --memory 1g --pids-limit 64 -v "$WORK:/verify" -w /app \
  -e NODE_PATH=/app/node_modules -e DB_PATH=/verify/djimitflo.sqlite -e BACKUP_DIR=/verify/backups \
  --entrypoint node "$IMAGE" -e "$VERIFY_JS"
