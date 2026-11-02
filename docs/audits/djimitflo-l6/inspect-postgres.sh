#!/bin/sh
# Read-only schema/approximate population metadata using existing container-local authentication.
set -eu
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' djimit-central-postgres \
  sh -c 'exec psql -XAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"' <<'SQL'
BEGIN READ ONLY;
SELECT json_build_object('read_only',current_setting('transaction_read_only'),'at',now(),'database',current_database(),'version',current_setting('server_version'));
SELECT json_build_object('schema',n.nspname,'table',c.relname,'estimated_rows',c.reltuples::bigint)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind='r'
ORDER BY 1::text,n.nspname,c.relname;
ROLLBACK;
SQL
