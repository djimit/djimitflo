import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { JudgeService, type ExpertAnswer } from '../services/judge-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let judge: JudgeService;

function createAnswer(overrides: Partial<ExpertAnswer> = {}): ExpertAnswer {
  return {
    domain: 'physics',
    content: 'Quantum mechanics describes nature at the smallest scales of energy levels of atoms and subatomic particles.',
    source: 'wikipedia',
    confidence: 0.8,
    evidence_refs: ['ref1', 'ref2', 'ref3'],
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  judge = new JudgeService(db);
});

afterEach(() => {
  db?.close();
});

describe('G95: Judge Service', () => {
  it('returns empty verdict for no answers', () => {
    const verdict = judge.evaluate([]);
    expect(verdict.score).toBe(0);
    expect(verdict.confidence).toBe(0);
    expect(verdict.verification_status).toBe('unverifiable');
  });

  it('evaluates single answer', () => {
    const verdict = judge.evaluate([createAnswer()]);
    expect(verdict.score).toBeGreaterThan(0);
    expect(verdict.score).toBeLessThanOrEqual(100);
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.reasoning).toBeDefined();
  });

  it('evaluates multiple answers from different domains', () => {
    const answers = [
      createAnswer({ domain: 'physics', source: 'arxiv', confidence: 0.9 }),
      createAnswer({ domain: 'math', source: 'wikipedia', confidence: 0.7 }),
      createAnswer({ domain: 'biology', source: 'okf', confidence: 0.6 }),
    ];

    const verdict = judge.evaluate(answers);
    expect(verdict.score).toBeGreaterThan(0);
    expect(verdict.score).toBeLessThanOrEqual(100);
  });

  it('scores arxiv higher than unknown source', () => {
    const arxivVerdict = judge.evaluate([createAnswer({ source: 'arxiv', confidence: 0.9 })]);
    const unknownVerdict = judge.evaluate([createAnswer({ source: 'unknown', confidence: 0.9 })]);

    expect(arxivVerdict.score).toBeGreaterThan(unknownVerdict.score);
  });

  it('detects contradictions between domains', () => {
    const answers = [
      createAnswer({ domain: 'physics', content: 'Light behaves as a wave according to quantum mechanics experiments.' }),
      createAnswer({ domain: 'optics', content: 'Light does not behave as a wave according to particle theory.' }),
    ];

    const verdict = judge.evaluate(answers);
    expect(verdict.contradictions.length).toBeGreaterThan(0);
  });

  it('does not flag non-contradictory answers', () => {
    const answers = [
      createAnswer({ domain: 'physics', content: 'Light is a wave.' }),
      createAnswer({ domain: 'math', content: 'Calculus is used in physics.' }),
    ];

    const verdict = judge.evaluate(answers);
    expect(verdict.contradictions.length).toBe(0);
  });

  it('assigns verification status based on score', () => {
    const highQuality = judge.evaluate([
      createAnswer({ source: 'arxiv', confidence: 0.95, evidence_refs: ['r1', 'r2', 'r3'] }),
      createAnswer({ domain: 'math', source: 'arxiv', confidence: 0.9, evidence_refs: ['r4', 'r5', 'r6'] }),
    ]);

    expect(highQuality.verification_status).toBe('verified');
  });

  it('assigns contradicted status for high contradictions', () => {
    const contradictory = judge.evaluate([
      createAnswer({ domain: 'physics', content: 'Quantum entanglement allows instantaneous communication across any distance.' }),
      createAnswer({ domain: 'optics', content: 'Quantum entanglement does not allow instantaneous communication across any distance.' }),
    ]);

    expect(contradictory.verification_status).toBe('contradicted');
  });

  it('generates recommendations for low scores', () => {
    const lowScore = judge.evaluate([createAnswer({ source: 'unknown', confidence: 0.2, evidence_refs: [] })]);

    expect(lowScore.recommendations.length).toBeGreaterThan(0);
    expect(lowScore.recommendations.some(r => r.includes('Evidence') || r.includes('sources'))).toBe(true);
  });

  it('persists verdicts to database', () => {
    judge.evaluate([createAnswer()]);
    judge.evaluate([createAnswer({ domain: 'math' })]);

    const history = judge.getVerdictHistory(10);
    expect(history.length).toBe(2);
  });

  it('retrieves verdict by id', () => {
    const verdict = judge.evaluate([createAnswer()]);
    const retrieved = judge.getVerdict(verdict.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(verdict.id);
    expect(retrieved!.score).toBe(verdict.score);
  });

  it('returns null for unknown verdict id', () => {
    const retrieved = judge.getVerdict('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('calculates confidence with agreement bonus', () => {
    const single = judge.evaluate([createAnswer({ confidence: 0.8 })]);
    const multiple = judge.evaluate([
      createAnswer({ confidence: 0.8 }),
      createAnswer({ domain: 'math', confidence: 0.8 }),
      createAnswer({ domain: 'bio', confidence: 0.8 }),
    ]);

    expect(multiple.confidence).toBeGreaterThanOrEqual(single.confidence);
  });
});
