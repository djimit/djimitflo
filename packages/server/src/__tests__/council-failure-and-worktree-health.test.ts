import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CouncilOrchestrator } from '../services/council-orchestrator';
import { CouncilRegistry } from '../services/council-registry';
import { SelfHealingService } from '../services/self-healing-service';

describe('council failure reason', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); });
  afterEach(() => db.close());

  it('persists the message and phase of a failed session', async () => {
    const registry = new CouncilRegistry(db);
    registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b', privacy_class: 'local', independence_score: 0.9, avg_governance_score: 3.5 });
    registry.registerModel({ provider: 'openai', model_name: 'gpt-4o', privacy_class: 'public_api', independence_score: 0.7, avg_governance_score: 4.2 });
    registry.registerModel({ provider: 'anthropic', model_name: 'claude-3-5-sonnet', privacy_class: 'public_api', independence_score: 0.8, avg_governance_score: 4.0 });
    registry.registerModel({ provider: 'google', model_name: 'gemini-1.5-pro', privacy_class: 'public_api', independence_score: 0.75, avg_governance_score: 3.8 });
    const orchestrator = new CouncilOrchestrator(db);
    const session = await orchestrator.createSession({ task_description: 'x', mode: 'council', risk_class: 'low' });
    vi.spyOn(orchestrator as never, 'executeDivergePhase').mockRejectedValue(new Error('COUNCIL_TEST_BOOM'));
    await expect(orchestrator.executeCouncil(session.id)).rejects.toThrow('COUNCIL_TEST_BOOM');
    const failed = orchestrator.getSession(session.id);
    expect(failed.status).toBe('failed');
    expect((failed.metadata as { failure?: { message: string; phase: string } }).failure).toMatchObject({ message: 'COUNCIL_TEST_BOOM', phase: 'diverging' });
  });
});

describe('orphaned_worktrees health check', () => {
  let db: Database.Database;
  let root: string;
  const prev = process.env.LOOP_WORKTREE_ROOT;
  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
    process.env.LOOP_WORKTREE_ROOT = root;
  });
  afterEach(() => {
    db.close(); fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.LOOP_WORKTREE_ROOT; else process.env.LOOP_WORKTREE_ROOT = prev;
  });
  const orphanMessage = () => new SelfHealingService(db).checkHealth().find((c) => c.name === 'orphaned_worktrees')!.message;

  it('counts directories on disk, not leases that merely keep a worktree_path', () => {
    expect(orphanMessage()).toContain('0 orphaned worktree directories');
    const dir = path.join(root, 'run-1', 'finding-1');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(dir, old, old);
    expect(orphanMessage()).toContain('1 orphaned worktree directories');
  });
});
