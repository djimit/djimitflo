import { describe, expect, it } from 'vitest';
import { decisionContextJudgment } from '../services/decision-context-service';

describe('decisionContextJudgment', () => {
  it('returns a judgment def with id "decision_context"', () => {
    expect(decisionContextJudgment(1).id).toBe('decision_context');
  });

  it('creates one noul question per candidate', () => {
    const def = decisionContextJudgment(3);
    const keys = Object.keys(def.questions);
    expect(keys).toEqual(['m0', 'm1', 'm2']);
    for (const key of keys) {
      expect(def.questions[key].type).toBe('noul');
      expect(def.questions[key].instructions).toContain(`memories[${Number(key.slice(1))}]`);
      expect(def.questions[key].criteria).toBeDefined();
    }
  });

  it('produces no questions for count 0', () => {
    const def = decisionContextJudgment(0);
    expect(Object.keys(def.questions)).toEqual([]);
  });

  it('decides "no" with "selected=none" when no answer exceeds the relevance threshold', () => {
    const def = decisionContextJudgment(2);
    const result = def.decide({ m0: { type: 'noul', noul: 0.4 }, m1: { type: 'noul', noul: 0.69 } });
    expect(result.decision).toBe('no');
    expect(result.reason).toBe('selected=none');
  });

  it('decides "yes" and lists the picked memory keys when answers exceed the threshold', () => {
    const def = decisionContextJudgment(3);
    const result = def.decide({
      m0: { type: 'noul', noul: 0.2 },
      m1: { type: 'noul', noul: 0.9 },
      m2: { type: 'noul', noul: 0.75 },
    });
    expect(result.decision).toBe('yes');
    expect(result.reason).toBe('selected=m1,m2');
  });

  it('treats missing noul values as below threshold', () => {
    const def = decisionContextJudgment(2);
    const result = def.decide({ m0: { type: 'noul' }, m1: { type: 'noul', noul: 0.8 } });
    expect(result.decision).toBe('yes');
    expect(result.reason).toBe('selected=m1');
  });

  it('decides "no" when answers map is empty', () => {
    const def = decisionContextJudgment(2);
    const result = def.decide({});
    expect(result.decision).toBe('no');
    expect(result.reason).toBe('selected=none');
  });
});