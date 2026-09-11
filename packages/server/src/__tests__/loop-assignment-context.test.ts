import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService, type LoopRunRecord, type LoopFinding } from '../services/loop-service';

describe('loop assignment advisory context', () => {
  let db: Database.Database;
  let worktree: string;
  let loops: LoopService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    loops = new LoopService(db);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-assignment-context-'));
    db.prepare(`INSERT INTO experience_embeddings
      (run_id, objective, outcome, retries, runtime, capability_id, lessons, total_tokens)
      VALUES ('assignment-episode', 'Fix documentation drift assignment', 'success', 0, 'codex', 'docs-proof', ?, 800)`)
      .run(JSON.stringify(['reuse verified local evidence']));
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    db.close();
  });

  it('uses one persisted snapshot in both worker files', () => {
    const run = { id: 'assignment-run', loop_name: 'doc-drift-and-small-fix-loop', goal_id: null, mode: 'closed', status: 'planning', metadata: {}, gates: [], next_actions: [], plan: {}, state_file: null, repository_path: worktree } as unknown as LoopRunRecord;
    const finding = { id: 'finding-1', type: 'documentation', severity: 'low', file: 'README.md', line: 1, message: 'Fix documentation drift assignment', evidence: 'fixture', suggested_fix: 'reuse verified local evidence' } as LoopFinding;

    loops.writeWorkAssignment(worktree, run, finding, 'codex');
    const packetPath = loops.writeAssignmentPacket(worktree, run, finding, 'codex');
    const assignment = fs.readFileSync(loops.workAssignmentPath(worktree), 'utf8');
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')) as any;

    expect(packet.advisory_context).toMatchObject({ advisory: true, independently_reviewed: false, sources: ['experience_retrieval'] });
    expect(assignment).toContain(packet.advisory_context.text);
    expect(packet.advisory_context.sha256).toBeTruthy();
    expect(fs.existsSync(path.join(worktree, '.djimitflo', 'ASSIGNMENT_CONTEXT.json'))).toBe(true);
  });
});
