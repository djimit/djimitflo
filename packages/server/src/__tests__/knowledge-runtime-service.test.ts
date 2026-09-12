import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createSwarmRoutes } from '../routes/swarms';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

const previousOkfBase = process.env.OKF_BASE;
const previousValidatorPath = process.env.OKF_VALIDATOR_PATH;
const tempDirs: string[] = [];

beforeEach(() => { delete process.env.OKF_VALIDATOR_PATH; });

// The repo knowledge symlink targets a directory outside the repo (present on
// dev machines, absent in CI); smoke tests that assert the real runtime only
// make sense where it actually resolves.
const repoKnowledgeAvailable = fs.existsSync(KnowledgeRuntimeService.repoKnowledgePath());

afterEach(() => {
  vi.restoreAllMocks();
  if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
  else delete process.env.OKF_BASE;
  if (previousValidatorPath === undefined) delete process.env.OKF_VALIDATOR_PATH;
  else process.env.OKF_VALIDATOR_PATH = previousValidatorPath;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function db() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database);
  return database;
}

function okf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-runtime-'));
  const okfBase = path.join(root, 'okf');
  fs.mkdirSync(path.join(okfBase, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'validate_okf.py'), 'print("OK: test OKF valid")\n', 'utf8');
  tempDirs.push(root);
  return okfBase;
}

describe('KnowledgeRuntimeService', () => {
  it('uses an explicitly configured external validator against the actual data bundle', () => {
    const dataBase = okf();
    const toolsBase = okf();
    process.env.OKF_BASE = dataBase;
    process.env.OKF_VALIDATOR_PATH = path.join(path.dirname(toolsBase), 'tools', 'validate_okf.py');
    fs.writeFileSync(process.env.OKF_VALIDATOR_PATH, [
      'import os',
      'from pathlib import Path',
      `assert Path(os.environ["OKF_BASE"]).resolve() == Path(${JSON.stringify(dataBase)}).resolve()`,
      'assert os.environ["PYTHONDONTWRITEBYTECODE"] == "1"',
      'print("EXTERNAL_VALIDATOR_ACTUAL_DATA")',
    ].join('\n'));
    const database = db();
    try {
      const service = new KnowledgeRuntimeService(database);
      const health = service.health();
      expect(health.okf_base).toBe(dataBase);
      expect(health.validate_okf.status).toBe('pass');
      expect(health.validate_okf.stdout).toBe('EXTERNAL_VALIDATOR_ACTUAL_DATA');
      expect(health.validate_okf.command).toContain(process.env.OKF_VALIDATOR_PATH);
      expect(service.syncCapabilities({ apply: true }).dry_run).toBe(false);
    } finally { database.close(); }
  });

  it('fails closed without a validator while preserving read-only sync preview', () => {
    const dataBase = okf();
    process.env.OKF_BASE = dataBase;
    fs.unlinkSync(path.join(path.dirname(dataBase), 'tools', 'validate_okf.py'));
    fs.writeFileSync(path.join(dataBase, 'skills', 'candidate.md'), '---\ntitle: Unvalidated fixture\n---\nFixture');
    const database = db();
    try {
      const service = new KnowledgeRuntimeService(database);
      expect(service.health().validate_okf.status).toBe('fail');
      expect(service.health().blocked_reasons).toContain('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
      expect(service.syncCapabilities({ dry_run: true }).dry_run).toBe(true);
      expect(() => service.syncCapabilities({ apply: true })).toThrow('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
      expect(database.prepare('SELECT COUNT(*) AS count FROM swarm_capabilities').get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });

  it.each(['missing', 'relative', 'failed'] as const)('does not silently fall back when operator validator is %s', (mode) => {
    const dataBase = okf();
    const toolsBase = okf();
    process.env.OKF_BASE = dataBase;
    const external = path.join(path.dirname(toolsBase), 'tools', 'external.py');
    process.env.OKF_VALIDATOR_PATH = mode === 'relative' ? 'tools/external.py' : external;
    if (mode === 'failed') fs.writeFileSync(external, 'import sys\nprint("VALIDATION_REJECTED", file=sys.stderr)\nsys.exit(3)\n');
    const database = db();
    try {
      const service = new KnowledgeRuntimeService(database);
      const health = service.health();
      expect(health.validate_okf.status).toBe('fail');
      expect(health.valid).toBe(false);
      if (mode === 'failed') expect(health.validate_okf.stderr).toContain('VALIDATION_REJECTED');
      expect(() => service.syncCapabilities({ apply: true })).toThrow('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
      expect(database.prepare('SELECT COUNT(*) AS count FROM swarm_capabilities').get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });

  it('requires pass rather than merely not-fail before applying sync', () => {
    process.env.OKF_BASE = okf();
    const database = db();
    try {
      const service = new KnowledgeRuntimeService(database);
      const health = service.health();
      vi.spyOn(service, 'health').mockReturnValue({ ...health, validate_okf: { ...health.validate_okf, status: 'skipped' } });
      expect(() => service.syncCapabilities({ apply: true })).toThrow('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');
    } finally { database.close(); }
  });

  it('resolves canonical OKF from OKF_BASE and reports read-only health', () => {
    const okfBase = okf();
    process.env.OKF_BASE = okfBase;
    fs.writeFileSync(path.join(okfBase, 'skills', 'valid.md'), [
      '---',
      'title: Valid Skill',
      'allowed_actions: [read_repo]',
      'forbidden_actions: [deploy]',
      'required_evidence: [test]',
      'risk_ceiling: low',
      'eval_threshold: 0.75',
      'removal_strategy: disable skill',
      '---',
      '# Valid Skill',
    ].join('\n'), 'utf8');

    const database = db();
    try {
      const health = new KnowledgeRuntimeService(database).health();
      expect(health.okf_base).toBe(okfBase);
      expect(health.validate_okf.status).toBe('pass');
      expect(health.counts.skills).toBe(1);
      expect(health.drift.packages_knowledge_is_canonical).toBe(false);
    } finally {
      database.close();
    }
  });

  it('rejects packages/knowledge as canonical runtime OKF base', () => {
    process.env.OKF_BASE = path.resolve(__dirname, '../../../..', 'packages', 'knowledge');
    expect(() => KnowledgeRuntimeService.resolveCanonicalOkfBase()).toThrow('KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
  });

  it('fails when the canonical OKF base is missing', () => {
    process.env.OKF_BASE = path.join(os.tmpdir(), `missing-okf-${Date.now()}`);
    expect(() => KnowledgeRuntimeService.resolveCanonicalOkfBase()).toThrow('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
  });

  it.skipIf(!repoKnowledgeAvailable)('smokes the repo knowledge symlink as canonical runtime without health writes', () => {
    delete process.env.OKF_BASE;
    const repoKnowledge = KnowledgeRuntimeService.repoKnowledgePath();
    expect(fs.existsSync(repoKnowledge)).toBe(true);
    const before = fs.statSync(repoKnowledge).mtimeMs;
    const database = db();
    try {
      const health = new KnowledgeRuntimeService(database).health();
      expect(path.resolve(health.okf_base || '')).toBe(path.resolve(repoKnowledge));
      expect(health.drift.packages_knowledge_is_canonical).toBe(false);
      expect(health.validate_okf.status).toEqual(expect.stringMatching(/pass|fail|skipped/));
      expect(health.counts).toHaveProperty('skills');
      expect(health.blocked_reasons).toEqual(expect.any(Array));
      expect(fs.statSync(repoKnowledge).mtimeMs).toBe(before);
    } finally {
      database.close();
    }
  });

  it.skipIf(!repoKnowledgeAvailable)('exposes canonical knowledge runtime through the swarm API', async () => {
    delete process.env.OKF_BASE;
    const database = db();
    const app = express();
    app.use(express.json());
    app.use('/swarms', createSwarmRoutes(database, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    app.use(errorHandler);
    let server: Server | null = null;
    try {
      server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
      });
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/swarms/knowledge/runtime`);
      expect(response.status).toBe(200);
      const health = await response.json() as any;
      expect(path.resolve(health.okf_base)).toBe(path.resolve(KnowledgeRuntimeService.repoKnowledgePath()));
      expect(health.drift.packages_knowledge_is_canonical).toBe(false);
      expect(health.counts).toHaveProperty('skills');
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
      }
      database.close();
    }
  });
});
