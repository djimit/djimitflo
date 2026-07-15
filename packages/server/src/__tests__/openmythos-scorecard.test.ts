import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';

function insertRun(db: Database, run: {
  id: string;
  agentId: string;
  status?: string;
  overallScore?: number;
  completedCases?: number;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
}) {
  db.prepare(`
    INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.agentId,
    run.status ?? 'completed',
    run.completedCases ?? 78,
    run.completedCases ?? 78,
    run.overallScore ?? 3.0,
    run.startedAt ?? '2026-07-15T10:00:00.000Z',
    run.finishedAt ?? '2026-07-15T10:05:00.000Z',
    JSON.stringify(run.metadata ?? {}),
  );
}

describe('OpenMythos scorecard queries', () => {
  let db: Database;
  let service: OpenMythosEvalService;

  beforeEach(() => {
    db = createTestDb();
    service = new OpenMythosEvalService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('listRuns', () => {
    it('returns runs newest first with parsed metadata', () => {
      insertRun(db, {
        id: 'run-old', agentId: 'agent-a', startedAt: '2026-07-14T10:00:00.000Z',
        metadata: { subject_model: 'llama3.1:8b', oracle_cases: 78, judge_cases: 0 },
      });
      insertRun(db, { id: 'run-new', agentId: 'agent-b', startedAt: '2026-07-15T10:00:00.000Z' });

      const runs = service.listRuns();
      expect(runs.map((r) => r.id)).toEqual(['run-new', 'run-old']);
      expect(runs[1]).toMatchObject({
        agentId: 'agent-a',
        subjectModel: 'llama3.1:8b',
        oracleCases: 78,
        judgeCases: 0,
      });
      expect(runs[0].subjectModel).toBeNull();
    });

    it('respects the limit and survives malformed metadata', () => {
      for (let i = 0; i < 5; i++) {
        insertRun(db, { id: `run-${i}`, agentId: 'agent-a', startedAt: `2026-07-1${i}T10:00:00.000Z` });
      }
      db.prepare("UPDATE openmythos_eval_runs SET metadata = 'not json' WHERE id = 'run-4'").run();

      const runs = service.listRuns(2);
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBe('run-4');
      expect(runs[0].subjectModel).toBeNull();
    });

    it('returns empty array when there are no runs', () => {
      expect(service.listRuns()).toEqual([]);
    });
  });

  describe('getLeaderboard', () => {
    it('ranks agents by latest completed score, best first', () => {
      insertRun(db, {
        id: 'a1', agentId: 'agent-a', overallScore: 2.0, finishedAt: '2026-07-14T10:00:00.000Z',
        metadata: { category_scores: { injection: 3.5 } },
      });
      insertRun(db, {
        id: 'a2', agentId: 'agent-a', overallScore: 3.5, finishedAt: '2026-07-15T10:00:00.000Z',
        metadata: { category_scores: { injection: 4.0 } },
      });
      insertRun(db, { id: 'b1', agentId: 'agent-b', overallScore: 2.5 });

      const board = service.getLeaderboard();
      expect(board.map((s) => s.agentId)).toEqual(['agent-a', 'agent-b']);
      // latest run wins, not the best run
      expect(board[0].overallScore).toBe(3.5);
      expect(board[0].categoryScores).toEqual({ injection: 4.0 });
      expect(board[0].trend).toBe('improving');
    });

    it('excludes agents with only failed runs', () => {
      insertRun(db, { id: 'f1', agentId: 'agent-failed', status: 'failed' });
      insertRun(db, { id: 'c1', agentId: 'agent-ok' });

      const board = service.getLeaderboard();
      expect(board.map((s) => s.agentId)).toEqual(['agent-ok']);
    });

    it('returns empty array with no eval data', () => {
      expect(service.getLeaderboard()).toEqual([]);
    });
  });
});
