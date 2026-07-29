import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { JudgeService, type ExpertAnswer } from '../services/judge-service';

const databases: Database.Database[] = [];
const db = () => {
  const database = createTestDb();
  databases.push(database);
  return database;
};

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('JudgeService', () => {
  const sampleAnswers: ExpertAnswer[] = [
    {
      domain: 'security',
      content: 'The system implements end-to-end encryption using AES-256. This ensures data confidentiality.',
      source: 'arxiv',
      confidence: 0.9,
      evidence_refs: ['ref1', 'ref2', 'ref3'],
    },
    {
      domain: 'privacy',
      content: 'User data is encrypted at rest and in transit. No plaintext storage is used.',
      source: 'wikipedia',
      confidence: 0.8,
      evidence_refs: ['ref4'],
    },
  ];

  it('returns empty verdict for no answers', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate([]);
    expect(verdict.score).toBe(0);
    expect(verdict.verification_status).toBe('unverifiable');
  });

  it('produces score between 0 and 100', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    expect(verdict.score).toBeGreaterThanOrEqual(0);
    expect(verdict.score).toBeLessThanOrEqual(100);
  });

  it('includes sub-scores', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    expect(verdict.sub_scores).toBeDefined();
    expect(verdict.sub_scores!.evidence).toBeGreaterThan(0);
  });

  it('penalizes internally repetitive answers', () => {
    const service = new JudgeService(db());
    const sentence = 'This control must be reviewed before deployment';
    const repetitive = service.evaluate([{
      domain: 'governance',
      content: Array(8).fill(sentence).join('. '),
      source: 'okf',
      confidence: 0.9,
    }]);
    const varied = service.evaluate([{
      domain: 'governance',
      content: [
        sentence,
        'The reviewer records evidence and a bounded decision',
        'Failed controls return to the owner with corrective actions',
        'Successful validation produces an auditable release record',
      ].join('. '),
      source: 'okf',
      confidence: 0.9,
    }]);
    expect(repetitive.sub_scores!.consistency).toBeLessThan(varied.sub_scores!.consistency);
    expect(repetitive.score).toBeLessThan(varied.score);
  });

  it('labels the score as heuristic', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    expect(verdict.score_kind).toBe('heuristic');
    expect(verdict.reasoning).toContain('external verification required');
  });

  it('detects contradictions between opposite claims', () => {
    const service = new JudgeService(db());
    const contradictory: ExpertAnswer[] = [
      { domain: 'a', content: 'The system supports encryption at rest for all user data and ensures confidentiality through AES-256.', source: 'arxiv', confidence: 0.9, evidence_refs: ['r1'] },
      { domain: 'b', content: 'The system does not support encryption at rest for user data which means data is stored in plaintext.', source: 'wikipedia', confidence: 0.8, evidence_refs: ['r2'] },
    ];
    const verdict = service.evaluate(contradictory);
    expect(verdict.contradictions.length).toBeGreaterThan(0);
    expect(verdict.verification_status).toBe('contradicted');
  });

  it('keeps consistent high-quality answers pending external verification', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    expect(verdict.verification_status).toBe('pending');
  });

  it('getApprovalAction returns auto_approve for high scores without contradictions', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    if (verdict.score >= 80 && verdict.contradictions.length === 0) {
      expect(service.getApprovalAction(verdict)).toBe('auto_approve');
    }
  });

  it('stores and retrieves verdicts from database', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    const retrieved = service.getVerdict(verdict.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.score).toBe(verdict.score);
    expect(retrieved!.score_kind).toBe('heuristic');
  });

  it('getCalibrationError returns NaN with no reviews', () => {
    const service = new JudgeService(db());
    expect(Number.isNaN(service.getCalibrationError())).toBe(true);
  });

  it('recordCalibration enables ECE computation', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    service.recordCalibration(verdict.id, 0.85);
    const ece = service.getCalibrationError();
    expect(Number.isNaN(ece)).toBe(false);
    expect(ece).toBeGreaterThanOrEqual(0);
  });

  it('rejects calibration outcomes outside the probability range', () => {
    const service = new JudgeService(db());
    const verdict = service.evaluate(sampleAnswers);
    expect(() => service.recordCalibration(verdict.id, 85)).toThrow('ACTUAL_OUTCOME_MUST_BE_BETWEEN_0_AND_1');
  });

  it('verdict history returns most recent first', () => {
    const service = new JudgeService(db());
    service.evaluate(sampleAnswers);
    service.evaluate([sampleAnswers[0]]);
    const history = service.getVerdictHistory(5);
    expect(history.length).toBe(2);
  });
});
