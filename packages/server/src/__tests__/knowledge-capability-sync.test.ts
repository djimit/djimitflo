import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

const previousOkfBase = process.env.OKF_BASE;
const tempDirs: string[] = [];

afterEach(() => {
  if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
  else delete process.env.OKF_BASE;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database);
  return database;
}

function writeOkf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-sync-'));
  const okfBase = path.join(root, 'okf');
  fs.mkdirSync(path.join(okfBase, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(okfBase, 'agents'), { recursive: true });
  tempDirs.push(root);
  process.env.OKF_BASE = okfBase;
  fs.writeFileSync(path.join(okfBase, 'skills', 'complete.md'), [
    '---',
    'title: Complete Skill',
    'allowed_actions: [read_repo, propose_patch]',
    'forbidden_actions: [deploy]',
    'required_evidence: [test_output]',
    'risk_ceiling: medium',
    'eval_threshold: 0.7',
    'removal_strategy: disable if eval falls below threshold',
    '---',
    '# Complete Skill',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(okfBase, 'skills', 'incomplete.md'), [
    '---',
    'title: Incomplete Skill',
    '---',
    '# Incomplete Skill',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(okfBase, 'agents', 'memory-scientist.md'), [
    '---',
    'profile_id: memory_scientist',
    'title: Memory Scientist',
    'domains: [OKF]',
    'required_evidence: [source_ref]',
    'forbidden_claims: [unsupported memory]',
    'output_schema: [stance, evidence_refs]',
    '---',
    '# Memory Scientist',
  ].join('\n'), 'utf8');
  return okfBase;
}

function writeFailingOkf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-sync-fail-'));
  const okfBase = path.join(root, 'okf');
  fs.mkdirSync(path.join(okfBase, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'validate_okf.py'), 'import sys\nsys.exit(1)\n', 'utf8');
  fs.writeFileSync(path.join(okfBase, 'skills', 'complete.md'), [
    '---',
    'title: Complete Skill',
    'allowed_actions: [read_repo]',
    'forbidden_actions: [deploy]',
    'required_evidence: [test_output]',
    'risk_ceiling: low',
    'eval_threshold: 0.7',
    'removal_strategy: disable if eval falls below threshold',
    '---',
    '# Complete Skill',
  ].join('\n'), 'utf8');
  tempDirs.push(root);
  process.env.OKF_BASE = okfBase;
}

describe('OKF capability sync', () => {
  it('dry-runs without DB writes and apply upserts candidate/validated capabilities', () => {
    writeOkf();
    const database = makeDb();
    try {
      const service = new KnowledgeRuntimeService(database);
      const dry = service.syncCapabilities();
      expect(dry.dry_run).toBe(true);
      expect(dry.created).toBe(3);
      expect(database.prepare('SELECT COUNT(*) as count FROM swarm_capabilities').get()).toMatchObject({ count: 0 });

      const applied = service.syncCapabilities({ apply: true });
      expect(applied.dry_run).toBe(false);
      expect(applied.blocked).toBe(2);
      const rows = database.prepare('SELECT id, status, metadata FROM swarm_capabilities ORDER BY id').all() as any[];
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === 'skill:complete')).toMatchObject({ status: 'validated' });
      const incomplete = rows.find((row) => row.id === 'skill:incomplete');
      expect(incomplete).toMatchObject({ status: 'candidate' });
      expect(JSON.parse(incomplete.metadata).blocked_reasons).toContain('missing_allowed_actions');
    } finally {
      database.close();
    }
  });

  it('blocks apply when OKF validation fails', () => {
    writeFailingOkf();
    const database = makeDb();
    try {
      const service = new KnowledgeRuntimeService(database);
      const dry = service.syncCapabilities({ dry_run: true });
      expect(dry.created).toBe(1);
      expect(() => service.syncCapabilities({ apply: true })).toThrow('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
      expect(database.prepare('SELECT COUNT(*) as count FROM swarm_capabilities').get()).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });
});
