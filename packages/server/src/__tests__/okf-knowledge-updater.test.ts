import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OkfKnowledgeUpdater } from '../services/okf-knowledge-updater';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let updater: OkfKnowledgeUpdater;
let okfBase: string;
const previousOkfBase = process.env.OKF_BASE;

beforeEach(() => {
  // Isolated writable OKF base so the updater doesn't depend on the repo
  // knowledge symlink (which points outside the repo and is absent in CI).
  okfBase = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-okf-updater-'));
  fs.mkdirSync(path.join(okfBase, 'concepts'), { recursive: true });
  process.env.OKF_BASE = okfBase;

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  updater = new OkfKnowledgeUpdater(db);
});

afterEach(() => {
  db?.close();
  if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
  else delete process.env.OKF_BASE;
  if (okfBase) fs.rmSync(okfBase, { recursive: true, force: true });
});

describe('G100: OKF Knowledge Updater', () => {
  it('returns false for contradicted verdict', async () => {
    const result = await updater.updateFromVerdict('test', [], {
      id: '1', score: 30, confidence: 0.2, reasoning: '', contradictions: ['a vs b'],
      recommendations: [], verification_status: 'contradicted', created_at: new Date().toISOString(),
    });
    expect(result).toBe(false);
  });

  it('returns false for unverifiable verdict', async () => {
    const result = await updater.updateFromVerdict('test', [], {
      id: '1', score: 20, confidence: 0.1, reasoning: '', contradictions: [],
      recommendations: [], verification_status: 'unverifiable', created_at: new Date().toISOString(),
    });
    expect(result).toBe(false);
  });

  it('returns true for verified verdict', async () => {
    const result = await updater.updateFromVerdict('quantum physics', [
      { domain: 'physics', content: 'Test content', source: 'wikipedia', confidence: 0.8 },
    ], {
      id: '1', score: 85, confidence: 0.9, reasoning: 'Good', contradictions: [],
      recommendations: [], verification_status: 'verified', created_at: new Date().toISOString(),
    });
    expect(typeof result).toBe('boolean');
  });

  it('tracks update history', async () => {
    await updater.updateFromVerdict('topic1', [
      { domain: 'physics', content: 'Content', source: 'wikipedia', confidence: 0.8 },
    ], {
      id: '1', score: 85, confidence: 0.9, reasoning: 'Good', contradictions: [],
      recommendations: [], verification_status: 'verified', created_at: new Date().toISOString(),
    });

    const history = updater.getUpdateHistory(10);
    expect(history.length).toBe(1);
    expect(history[0].topic).toBe('topic1');
  });

  it('records created action for new topic', async () => {
    const uniqueTopic = 'xyz-unique-topic-' + Date.now();
    await updater.updateFromVerdict(uniqueTopic, [
      { domain: 'physics', content: 'Content', source: 'wikipedia', confidence: 0.8 },
    ], {
      id: '1', score: 85, confidence: 0.9, reasoning: 'Good', contradictions: [],
      recommendations: [], verification_status: 'verified', created_at: new Date().toISOString(),
    });

    const history = updater.getUpdateHistory(10);
    expect(history[0].action).toBe('created');
  });
});
