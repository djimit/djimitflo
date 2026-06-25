import { afterEach, describe, expect, it } from 'vitest';
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
const tempDirs: string[] = [];

afterEach(() => {
  if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
  else delete process.env.OKF_BASE;
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
    process.env.OKF_BASE = path.resolve(process.cwd(), '../..', 'packages', 'knowledge');
    expect(() => KnowledgeRuntimeService.resolveCanonicalOkfBase()).toThrow('KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
  });

  it('fails when the canonical OKF base is missing', () => {
    process.env.OKF_BASE = path.join(os.tmpdir(), `missing-okf-${Date.now()}`);
    expect(() => KnowledgeRuntimeService.resolveCanonicalOkfBase()).toThrow('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
  });

  it('smokes the repo knowledge symlink as canonical runtime without health writes', () => {
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

  it('exposes canonical knowledge runtime through the swarm API', async () => {
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
