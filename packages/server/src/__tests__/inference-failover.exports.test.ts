import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  notPanelFallbackReviewSql,
  limitMarker,
  recordLimitCalibration,
  PANEL_FALLBACK_PREFIX,
} from '../services/inference-failover';
import type { OllamaLimitState } from '../services/inference-failover';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
});
afterEach(() => {
  db.close();
});

describe('notPanelFallbackReviewSql', () => {
  it('returns a COALESCE NOT LIKE fragment for the given alias', () => {
    expect(notPanelFallbackReviewSql('r')).toBe(
      `COALESCE(r.model, '') NOT LIKE '${PANEL_FALLBACK_PREFIX}%'`,
    );
  });

  it('uses the claude: prefix constant', () => {
    const sql = notPanelFallbackReviewSql('review');
    expect(sql).toContain("NOT LIKE 'claude:%'");
  });

  it('embeds the alias verbatim in the SQL', () => {
    expect(notPanelFallbackReviewSql('x')).toContain('x.model');
  });
});

describe('limitMarker', () => {
  it('wraps each LimitClass in [ollama_usage_limit:<cls>]', () => {
    expect(limitMarker('weekly')).toBe('[ollama_usage_limit:weekly]');
    expect(limitMarker('session')).toBe('[ollama_usage_limit:session]');
    expect(limitMarker('daily')).toBe('[ollama_usage_limit:daily]');
    expect(limitMarker('hourly')).toBe('[ollama_usage_limit:hourly]');
    expect(limitMarker('monthly')).toBe('[ollama_usage_limit:monthly]');
    expect(limitMarker('usage')).toBe('[ollama_usage_limit:usage]');
  });
});

describe('recordLimitCalibration', () => {
  const state: OllamaLimitState = {
    state: 'ollama_limited',
    detected_at: '2026-10-01T00:00:00.000Z',
    error_class: 'weekly',
    source: 'test-source',
    excerpt: 'reached your weekly usage limit',
  };

  it('does not throw when the judgments table is absent (fail-soft)', () => {
    // no tables created — ollamaUsage7d and the INSERT both fail silently
    expect(() => recordLimitCalibration(db, state)).not.toThrow();
  });

  it('inserts an ollama_limit_calibration judgment row when the table exists', () => {
    db.exec(`CREATE TABLE judgments (
      id TEXT PRIMARY KEY,
      judgment TEXT NOT NULL,
      subject_type TEXT,
      subject_id TEXT,
      state_hash TEXT,
      mode TEXT,
      decision TEXT,
      reason TEXT,
      answers_json TEXT,
      created_at TEXT
    )`);
    // create empty ledger/lease tables so ollamaUsage7d returns zeros instead of null
    db.exec(`CREATE TABLE llm_model_calls (created_at TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER)`);
    db.exec(`CREATE TABLE worker_leases (runtime TEXT, created_at TEXT, metadata TEXT)`);

    const now = new Date('2026-10-02T00:00:00.000Z');
    recordLimitCalibration(db, state, now);

    const rows = db.prepare("SELECT * FROM judgments WHERE judgment = 'ollama_limit_calibration'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_type).toBe('inference_provider');
    expect(rows[0].subject_id).toBe('ollama');
    expect(rows[0].mode).toBe('annotation');
    expect(rows[0].decision).toBe('limit_hit');
    expect(rows[0].state_hash).toBe(`${state.error_class}:${state.detected_at}`);
    expect(rows[0].created_at).toBe(now.toISOString());
  });
});
