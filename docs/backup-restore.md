# Backup & Restore

Djimitflo provides admin-only backup and restore operations via the REST API. Backups are consistent SQLite snapshots packaged as `.tar.gz` archives with integrity checksums.

## Overview

- **Backup**: Creates a `.tar.gz` archive containing the SQLite database, a manifest with metadata, and SHA-256 checksums
- **Restore**: Stages a backup for restore — the actual database replacement happens on next server restart
- **Permission**: Requires `manage:backups` (admin role only)

## Backup Format

Each backup is a `.tar.gz` archive containing:

| File | Description |
|------|-------------|
| `manifest.json` | Metadata: app version, table counts, SHA-256, timestamps, warnings |
| `djimitflo.sqlite` | Consistent SQLite database snapshot (via `better-sqlite3.backup()`) |
| `checksums.sha256` | SHA-256 checksums for the database and manifest files |

### Manifest Structure

```json
{
  "backupVersion": "1.0",
  "appVersion": "0.5.8",
  "createdAt": "2026-05-18T19:33:59.000Z",
  "databasePath": "/data/djimitflo.sqlite",
  "tableCounts": { "tasks": 5, "agents": 2, ... },
  "totalTables": 15,
  "databaseSizeBytes": 45056,
  "databaseSha256": "sha256-hash...",
  "createdBy": "admin@example.com",
  "hostname": "server-01",
  "notes": [],
  "warnings": [
    "This backup contains password hashes and governance evidence. Treat as confidential.",
    "Environment secrets (JWT_SECRET, etc.) are NOT included. Store separately.",
    "Repository working trees are NOT included."
  ]
}
```

### Naming Convention

Backup filenames follow the pattern: `backup-YYYYMMDD-HHMMSS.tar.gz`

Example: `backup-20260518-193359.tar.gz`

## API Endpoints

All backup endpoints require authentication with the `manage:backups` permission (admin only).

### Create Backup

```
POST /api/backups
```

Creates a new backup. Returns immediately with metadata.

**Response** (`201`):
```json
{
  "filename": "backup-20260518-193359.tar.gz",
  "manifest": { ... },
  "sizeBytes": 12345
}
```

**Audit events**: `backup_created`

### List Backups

```
GET /api/backups
```

Returns a list of all available backups, sorted by creation date (newest first).

**Response** (`200`):
```json
[
  {
    "filename": "backup-20260518-193359.tar.gz",
    "manifest": { ... },
    "sizeBytes": 12345,
    "createdAt": "2026-05-18T19:33:59.000Z"
  }
]
```

### Get Backup Metadata

```
GET /api/backups/:filename
```

Returns metadata for a specific backup.

### Download Backup

```
GET /api/backups/:filename/download
```

Downloads the backup archive as a binary stream with `Content-Type: application/gzip`.

**Audit events**: `backup_downloaded`

### Validate Backup

```
POST /api/backups/:filename/validate
```

Validates a backup archive integrity — checks that the archive can be extracted, manifest is valid, and checksums match.

**Response** (`200`):
```json
{
  "valid": true,
  "errors": [],
  "manifest": { ... },
  "integrityCheck": "ok"
}
```

**Audit events**: `backup_validated`

### Restore Backup

```
POST /api/backups/:filename/restore
```

Stages a backup for restore. The actual database replacement happens on the next server restart.

**Request body**:
```json
{
  "confirm": "RESTORE"
}

The `confirm` field must be the exact string `"RESTORE"`. Any other value is rejected.

**Response** (`200`):
```json
{
  "restartRequired": true,
  "safetyBackupFilename": "backup-20260518-193400.tar.gz",
  "message": "Backup staged for restore. Restart the server to apply."
}
```

**Audit events**: `backup_restore_started`, `backup_pre_restore_created`

**Important**: A safety backup is automatically created before staging the restore. If something goes wrong, you can restore from the safety backup after restarting.

## Restore Process

Restore is **staged only** — it never overwrites the active database while the server is running.

### How It Works

1. **Create restore request**: `POST /api/backups/:filename/restore` with `confirm: "RESTORE"`
2. **Safety backup**: A pre-restore backup is created automatically
3. **Staging**: The backup archive is extracted to a `.restore-pending` temporary database file
4. **Marker file**: A `.restore-pending.json` marker is written to the backup directory with metadata about the restore
5. **Restart required**: The server returns `restartRequired: true`
6. **On next startup**: The server detects the marker, replaces the active database with the staged one, and records a `restore_completed` audit event

### Safety Mechanisms

- **Never hot-swaps**: The active database is never modified while the server is running
- **Automatic safety backup**: Created before any restore operation
- **Staged restore**: The replacement database is validated before being applied
- **Audit trail**: All backup and restore operations are logged with actor attribution

## Security Considerations

- Backup archives contain **password hashes** and **governance evidence** — treat them as confidential
- The `manage:backups` permission is admin-only
- No encryption is applied to backup archives in this phase
- Backup filenames are strictly validated: must match `^backup-\d{8}-\d{6}\.tar\.gz$`
- Path traversal is blocked: no slashes, backslashes, or `..` in filenames

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_DIR` | `<DATA_DIR>/backups` | Directory for backup archives |

In Docker, the default is `/data/backups` (inside the persistent volume).

## Disaster Recovery

### Full Recovery from Backup

```bash
# 1. List available backups
curl -H "Authorization: Bearer $TOKEN" \
  https://your-server/api/backups

# 2. Validate the backup
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://your-server/api/backups/backup-20260518-193359.tar.gz/validate

# 3. Stage the restore
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"RESTORE"}' \
  https://your-server/api/backups/backup-20260518-193359.tar.gz/restore

# 4. Restart the server
docker compose restart djimitflo

# 5. Verify the restore completed (task-scoped audit trail)
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-server/api/evidence/audit-trail/:taskId"

# Or verify via admin audit export
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format":"json","includeAudit":true,"dateFrom":"2026-01-01T00:00:00Z"}' \
  https://your-server/api/exports/audit
```

### Manual Recovery (Emergency)

If the API is unavailable, you can manually restore a backup:

```bash
# 1. Stop the server
docker compose down

# 2. Extract the backup archive
tar xzf backup-20260518-193359.tar.gz

# 3. Verify checksums
sha256sum -c checksums.sha256

# 4. Replace the database
cp djimitflo.sqlite /data/djimitflo.sqlite

# 5. Start the server
docker compose up -d
```

### Downloading Backups for Offsite Storage

```bash
# Download a backup archive
curl -H "Authorization: Bearer $TOKEN" \
  -o backup-20260518-193359.tar.gz \
  https://your-server/api/backups/backup-20260518-193359.tar.gz/download
```

## Limitations

- **No scheduled backups**: Must be triggered manually via API
- **No retention policy**: Backups accumulate until manually deleted
- **No encryption**: Archives are not encrypted at rest or in transit
- **No cloud storage**: Backups are stored locally in `BACKUP_DIR`
- **No hot restore**: Server restart is required to apply a restore
- **No repository data**: Git repository data is not included in backups
- **No .env/secrets**: Environment variables and secrets are not backed up