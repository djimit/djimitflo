import { describe, expect, it } from 'vitest';
import {
  reviewFailureKind,
  PARSE_ERRORS,
  QUARANTINE_SEAT_LIMIT,
  validateReview,
  PANEL_REVIEW_INSTRUCTIONS,
  type ReviewFailureKind,
} from '../services/self-improvement-agent-review-service';

describe('reviewFailureKind', () => {
  it('classifies every PARSE_ERRORS entry as "parse"', () => {
    for (const err of PARSE_ERRORS) {
      expect(reviewFailureKind(err)).toBe('parse' satisfies ReviewFailureKind);
    }
  });

  it('classifies schema-validation messages as "schema"', () => {
    const schemaErrors = [
      'stance must be one of support|oppose|uncertain|needs_evidence (got null)',
      'confidence must be a number between 0 and 1',
      'findings must be a non-empty array of strings',
      'evidence_refs must cite at least one concrete item from the context',
      'recommendations must be an array of strings',
      'limitations must be a string',
    ];
    for (const err of schemaErrors) {
      expect(reviewFailureKind(err)).toBe('schema' satisfies ReviewFailureKind);
    }
  });

  it('returns null for unrecognized error text', () => {
    expect(reviewFailureKind('something unexpected happened')).toBeNull();
    expect(reviewFailureKind('')).toBeNull();
  });
});

describe('QUARANTINE_SEAT_LIMIT', () => {
  it('is a small positive integer', () => {
    expect(typeof QUARANTINE_SEAT_LIMIT).toBe('number');
    expect(QUARANTINE_SEAT_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(QUARANTINE_SEAT_LIMIT)).toBe(true);
  });
});

describe('PANEL_REVIEW_INSTRUCTIONS', () => {
  it('is a non-empty array of instruction strings', () => {
    expect(Array.isArray(PANEL_REVIEW_INSTRUCTIONS)).toBe(true);
    expect(PANEL_REVIEW_INSTRUCTIONS.length).toBeGreaterThan(0);
    for (const line of PANEL_REVIEW_INSTRUCTIONS) {
      expect(typeof line).toBe('string');
    }
  });

  it('tells the reviewer that needs_evidence and oppose are valid', () => {
    const joined = PANEL_REVIEW_INSTRUCTIONS.join('\n');
    expect(joined).toContain('needs_evidence');
    expect(joined).toContain('oppose');
  });
});

describe('validateReview', () => {
  const validJson = JSON.stringify({
    stance: 'support',
    confidence: 0.8,
    findings: ['the proposal is sound'],
    recommendations: ['ship it'],
    evidence_refs: ['rationale paragraph 2'],
  });

  it('accepts a well-formed review', () => {
    const result = validateReview(validJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.stance).toBe('support');
      expect(result.review.confidence).toBe(0.8);
      expect(result.review.findings).toEqual(['the proposal is sound']);
      expect(result.review.evidence_refs).toEqual(['rationale paragraph 2']);
      expect(result.review.recommendations).toEqual(['ship it']);
    }
  });

  it('extracts JSON from a fenced code block with surrounding prose', () => {
    const wrapped = `Here is my review:\n\`\`\`json\n${validJson}\n\`\`\`\nDone.`;
    const result = validateReview(wrapped);
    expect(result.ok).toBe(true);
  });

  it('strips a <think> block before parsing', () => {
    const withThink = `<think>let me reason about this</think>${validJson}`;
    const result = validateReview(withThink);
    expect(result.ok).toBe(true);
  });

  it('rejects text with no JSON object as a parse failure', () => {
    const result = validateReview('I cannot review this proposal.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('parse');
      expect(reviewFailureKind(result.error)).toBe('parse');
    }
  });

  it('rejects invalid JSON as a parse failure', () => {
    const result = validateReview('{ stance: support }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('parse');
  });

  it('rejects a JSON array (not an object) as a parse failure', () => {
    const result = validateReview('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('parse');
  });

  it('rejects an out-of-set stance as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), stance: 'maybe' });
    const result = validateReview(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('schema');
      expect(reviewFailureKind(result.error)).toBe('schema');
    }
  });

  it('rejects confidence outside [0,1] as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), confidence: 1.5 });
    expect(validateReview(bad).ok).toBe(false);
    const neg = JSON.stringify({ ...JSON.parse(validJson), confidence: -0.1 });
    const result = validateReview(neg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects empty findings as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), findings: [] });
    const result = validateReview(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects placeholder-only evidence_refs as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), evidence_refs: ['...', 'n/a', 'todo'] });
    const result = validateReview(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('rejects a non-array recommendations field as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), recommendations: 'ship it' });
    const result = validateReview(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });

  it('accepts an optional limitations string', () => {
    const withLim = JSON.stringify({ ...JSON.parse(validJson), limitations: 'small sample size' });
    const result = validateReview(withLim);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.review.limitations).toBe('small sample size');
  });

  it('rejects a non-string limitations field as a schema failure', () => {
    const bad = JSON.stringify({ ...JSON.parse(validJson), limitations: 42 });
    const result = validateReview(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema');
  });
});