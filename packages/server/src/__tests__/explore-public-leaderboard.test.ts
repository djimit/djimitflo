import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExplorePublicRoutes } from '../routes/explore-public';
import { createTestDb } from './helpers/test-db';

const corpus = '71ca62e742f71c2830f198c01dbcacdcf75487b9ef96e661d3e297d6608d41b9';
const caseIds = Array.from({ length: 78 }, (_, i) => `case-${i}`);

afterEach(() => vi.unstubAllEnvs());

describe('public governance leaderboard', () => {
  it('is disabled unless explicitly enabled', async () => {
    vi.stubEnv('OPENMYTHOS_LEADERBOARD_PUBLIC', '');
    const db = createTestDb();
    try {
      const response = await request(express().use('/explore', createExplorePublicRoutes(db))).get('/explore/leaderboard');
      expect(response.status).toBe(404);
      expect(response.text).toContain('not published');
    } finally {
      db.close();
    }
  });

  it('exposes only complete model-only scores without case content', async () => {
    vi.stubEnv('OPENMYTHOS_LEADERBOARD_PUBLIC', 'true');
    const db = createTestDb();
    try {
      const insert = (id: string, agent: string, score: number, mode = 'model_only') => db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, metadata)
        VALUES (?, ?, ?, ?, 78, 78, ?, 'completed', ?)
      `).run(id, agent, '2026-09-07T03:00:00Z', '2026-09-07T03:00:00Z', score, JSON.stringify({
        evaluation_mode: mode, oracle_anchors_configured: 1, case_ids: caseIds, corpus_sha256: corpus,
      })) as unknown;
      insert('run-good', 'nightly:good', 2.69);
      insert('run-critic', 'explainer-critic', 87, 'critic');
      const response = await request(express().use('/explore', createExplorePublicRoutes(db))).get('/explore/leaderboard');
      expect(response.status).toBe(200);
      expect(response.body.leaderboard).toHaveLength(1);
      expect(response.body.leaderboard[0]).toMatchObject({ agent_id: 'nightly:good', overall_score: 2.69, total_cases: 78 });
      expect(response.body.leaderboard[0].prompt).toBeUndefined();
      expect(response.body.leaderboard[0].case_content).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
