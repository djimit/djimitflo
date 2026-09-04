import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { NasEvidenceService } from '../services/nas-evidence-service';
import { WorkItemService } from '../services/work-item-service';

let db: Database.Database;
let root: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-nas-evidence-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: unknown[]) {
  const file = path.join(root, name);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
}

function service(packets: unknown[], blocked: unknown[] = []) {
  return new NasEvidenceService(db, {
    packets: writeJsonl('packets.jsonl', packets),
    audit: writeJsonl('audit.jsonl', []),
    blocked: writeJsonl('blocked.jsonl', blocked),
  });
}

const packet = {
  source_path: 'Documenten/sovereign-platform-roadmap-2025-2030.html',
  title: 'Sovereign platform roadmap 2025-2030',
  domain: 'sovereign-ai',
  claim: 'Sovereign platform roadmap 2025-2030',
  confidence: 0.7,
  valid_until: '2026-12-31',
  risk_flags: [],
};

describe('NasEvidenceService', () => {
  it('summarizes approved packets and blocked review state', () => {
    const result = service([packet], [{ blocked_reasons: ['status_needs-redaction'] }]).summary();

    expect(result.status).toBe('amber');
    expect(result.approved_packets).toBe(1);
    expect(result.blocked_entries).toBe(1);
    expect(result.needs_redaction).toBe(1);
    expect(result.oldest_valid_until).toBe('2026-12-31');
  });

  it('marks raw export packets red and excludes them from import preview', () => {
    const raw = { ...packet, source_path: 'ChatGPT export/private.md' };
    const nas = service([raw]);

    expect(nas.summary().blocked_reasons).toContain('NAS_EVIDENCE_RAW_EXPORT_PACKET');
    expect(nas.importPreview().work_items).toHaveLength(0);
  });

  it('previews idempotent work items without creating them', () => {
    const nas = service([packet]);
    const preview = nas.importPreview();

    expect(preview.dry_run).toBe(true);
    expect(preview.create).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as count FROM work_items').get()).toMatchObject({ count: 0 });

    new WorkItemService(db).create({
      ...preview.work_items[0],
      metadata: { test: true },
    });

    const secondPreview = nas.importPreview();
    expect(secondPreview.create).toBe(0);
    expect(secondPreview.existing).toBe(1);
  });

  it('fails closed when artifact paths are missing', () => {
    const result = new NasEvidenceService(db, { packets: null, audit: null, blocked: null }).summary();

    expect(result.status).toBe('red');
    expect(result.blocked_reasons).toContain('NAS_EVIDENCE_PACKETS_PATH_MISSING');
    expect(result.blocked_reasons).toContain('NAS_EVIDENCE_BLOCKED_PATH_MISSING');
  });
});
