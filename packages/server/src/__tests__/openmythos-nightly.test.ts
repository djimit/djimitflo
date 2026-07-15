import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { OpenMythosNightlyService } from '../services/openmythos-nightly-service';

const NIGHTLY_ENV_KEYS = [
  'OPENMYTHOS_NIGHTLY_ENABLED', 'OPENMYTHOS_NIGHTLY_MODELS', 'OPENMYTHOS_NIGHTLY_HOUR',
  'OPENMYTHOS_ORACLE_ANCHORS_PATH',
];

function at(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 30, 0, 0);
  return d;
}

describe('OpenMythosNightlyService', () => {
  let db: Database;
  let runEval: ReturnType<typeof vi.fn>;
  let service: OpenMythosNightlyService;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    for (const key of NIGHTLY_ENV_KEYS) delete process.env[key];
    db = createTestDb();
    runEval = vi.fn().mockResolvedValue({ overallScore: 3.0, completedCases: 78, totalCases: 78 });
    service = new OpenMythosNightlyService(db, { runEval } as any);
  });

  afterEach(() => {
    service.stop();
    db.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('does not arm unless explicitly enabled', () => {
    expect(service.start()).toBe(false);

    process.env.OPENMYTHOS_NIGHTLY_ENABLED = 'true';
    expect(service.start()).toBe(false); // no models configured

    process.env.OPENMYTHOS_NIGHTLY_MODELS = 'llama3.1:8b';
    process.env.OPENMYTHOS_NIGHTLY_HOUR = '23'; // boot-tick stays a no-op in this test
    expect(service.start()).toBe(true);
  });

  it('is not due before the target hour and due after', () => {
    process.env.OPENMYTHOS_NIGHTLY_MODELS = 'llama3.1:8b';
    process.env.OPENMYTHOS_NIGHTLY_HOUR = '3';

    expect(service.shouldRun('llama3.1:8b', at(2))).toBe(false);
    expect(service.shouldRun('llama3.1:8b', at(4))).toBe(true);
  });

  it('dedupes: a run already recorded today makes the model not due', () => {
    process.env.OPENMYTHOS_NIGHTLY_HOUR = '0';
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at)
      VALUES ('r1', 'nightly:llama3.1:8b', 'completed', 78, 78, 3.0, ?)
    `).run(new Date().toISOString());

    expect(service.shouldRun('llama3.1:8b', at(12))).toBe(false);
    expect(service.shouldRun('other-model', at(12))).toBe(true);
  });

  it('tick runs each due model once and one failure does not stop the rest', async () => {
    process.env.OPENMYTHOS_NIGHTLY_MODELS = 'model-a, model-b';
    process.env.OPENMYTHOS_NIGHTLY_HOUR = '0';
    runEval.mockRejectedValueOnce(new Error('ollama down'));

    const ran = await service.tick(at(12));

    expect(runEval).toHaveBeenCalledTimes(2);
    expect(runEval).toHaveBeenCalledWith('nightly:model-a', undefined, 'model-a', undefined);
    expect(runEval).toHaveBeenCalledWith('nightly:model-b', undefined, 'model-b', undefined);
    expect(ran).toEqual(['model-b']); // model-a failed
  });

  it('passes the oracle-anchored case ids when an anchors file is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-anchors-'));
    try {
      const anchorsPath = join(dir, 'anchors.json');
      writeFileSync(anchorsPath, JSON.stringify({
        schema_version: 1,
        anchors: [{ case_id: 'injection-001' }, { case_id: 'canary-004' }],
      }));
      process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = anchorsPath;
      process.env.OPENMYTHOS_NIGHTLY_MODELS = 'model-a';
      process.env.OPENMYTHOS_NIGHTLY_HOUR = '0';

      await service.tick(at(12));

      expect(runEval).toHaveBeenCalledWith('nightly:model-a', undefined, 'model-a', ['injection-001', 'canary-004']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
