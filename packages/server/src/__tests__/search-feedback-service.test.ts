import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SearchFeedbackService } from '../services/search-feedback-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let feedback: SearchFeedbackService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  feedback = new SearchFeedbackService(db);
});

afterEach(() => {
  db?.close();
});

describe('G46: Search Feedback Loop', () => {
  it('records feedback with valid reward', () => {
    feedback.recordFeedback('result-1', 'qdrant', 0.9, 'cap-a');
    const stats = feedback.getFeedbackStats('result-1');
    expect(stats.count).toBe(1);
    expect(stats.averageReward).toBe(0.9);
  });

  it('clamps reward to [0, 1]', () => {
    feedback.recordFeedback('result-2', 'okf', 1.5);
    feedback.recordFeedback('result-2', 'okf', -0.5);
    const stats = feedback.getFeedbackStats('result-2');
    expect(stats.averageReward).toBe(0.5);
  });

  it('getFeedbackWeight returns 0.5 for unknown result', () => {
    const weight = feedback.getFeedbackWeight('unknown');
    expect(weight).toBe(0.5);
  });

  it('getFeedbackWeight increases with positive feedback', () => {
    for (let i = 0; i < 10; i++) {
      feedback.recordFeedback('result-pos', 'qdrant', 1.0);
    }
    const weight = feedback.getFeedbackWeight('result-pos');
    expect(weight).toBeGreaterThan(0.5);
  });

  it('getFeedbackWeight decreases with negative feedback', () => {
    for (let i = 0; i < 10; i++) {
      feedback.recordFeedback('result-neg', 'qdrant', 0.0);
    }
    const weight = feedback.getFeedbackWeight('result-neg');
    expect(weight).toBeLessThan(0.5);
  });

  it('getTopResults returns highest rewarded first', () => {
    feedback.recordFeedback('low', 'qdrant', 0.2);
    feedback.recordFeedback('high', 'qdrant', 0.9);
    feedback.recordFeedback('mid', 'qdrant', 0.5);
    const top = feedback.getTopResults('qdrant', 3);
    expect(top[0].resultId).toBe('high');
    expect(top[2].resultId).toBe('low');
  });

  it('getResultsByCapability filters by capability', () => {
    feedback.recordFeedback('r1', 'qdrant', 0.9, 'cap-a');
    feedback.recordFeedback('r2', 'qdrant', 0.8, 'cap-b');
    feedback.recordFeedback('r3', 'qdrant', 0.7, 'cap-a');
    const results = feedback.getResultsByCapability('cap-a', 10);
    expect(results.length).toBe(2);
  });

  it('pruneOldFeedback removes old records', () => {
    feedback.recordFeedback('old', 'qdrant', 0.5);
    db.prepare("UPDATE search_feedback SET created_at = datetime('now', '-100 days') WHERE result_id = 'old'").run();
    feedback.recordFeedback('new', 'qdrant', 0.5);
    const pruned = feedback.pruneOldFeedback(90);
    expect(pruned).toBe(1);
    expect(feedback.getFeedbackCount()).toBe(1);
  });

  it('getFeedbackCount returns total count', () => {
    feedback.recordFeedback('r1', 'qdrant', 0.5);
    feedback.recordFeedback('r2', 'okf', 0.7);
    expect(feedback.getFeedbackCount()).toBe(2);
  });

  it('getRecentFeedback returns most recent first', () => {
    feedback.recordFeedback('first', 'qdrant', 0.1);
    feedback.recordFeedback('second', 'qdrant', 0.2);
    feedback.recordFeedback('third', 'qdrant', 0.3);
    const recent = feedback.getRecentFeedback(2);
    expect(recent.length).toBe(2);
    expect(recent[0].reward).toBe(0.3);
  });

  it('confidence increases with more feedback', () => {
    for (let i = 0; i < 3; i++) {
      feedback.recordFeedback('conf', 'qdrant', 1.0);
    }
    const lowConf = feedback.getFeedbackWeight('conf');
    for (let i = 0; i < 15; i++) {
      feedback.recordFeedback('conf', 'qdrant', 1.0);
    }
    const highConf = feedback.getFeedbackWeight('conf');
    expect(highConf).toBeGreaterThan(lowConf);
  });

  it('multiple sources tracked separately', () => {
    feedback.recordFeedback('shared', 'qdrant', 0.9);
    feedback.recordFeedback('shared', 'okf', 0.3);
    const stats = feedback.getFeedbackStats('shared');
    expect(stats.count).toBe(2);
    expect(stats.averageReward).toBe(0.6);
  });

  it('feedback weight saturates at extremes', () => {
    for (let i = 0; i < 100; i++) {
      feedback.recordFeedback('saturated', 'qdrant', 1.0);
    }
    const weight = feedback.getFeedbackWeight('saturated');
    expect(weight).toBeLessThanOrEqual(1.0);
    expect(weight).toBeGreaterThan(0.9);
  });
});
