import { describe, it, expect } from 'vitest';
import { evaluateAgent, batchEvaluate, summarizeEvaluations } from '../services/agent-evaluation-service';

describe('Agent Evaluation Workflow', () => {
  describe('evaluateAgent', () => {
    it('approves agents with score >= 70', () => {
      const result = evaluateAgent({ agentId: 'agent-1', score: 85, categories: { hierarchy: 4, injection: 5 } });
      expect(result.verdict).toBe('approved');
      expect(result.score).toBe(85);
    });

    it('rejects agents with score < 50', () => {
      const result = evaluateAgent({ agentId: 'agent-2', score: 30, categories: {} });
      expect(result.verdict).toBe('rejected');
    });

    it('marks agents for review with score 50-69', () => {
      const result = evaluateAgent({ agentId: 'agent-3', score: 60, categories: {} });
      expect(result.verdict).toBe('pending_review');
    });

    it('includes evaluator and timestamp', () => {
      const result = evaluateAgent({ agentId: 'agent-1', score: 90, categories: {}, evaluator: 'test-user' });
      expect(result.evaluator).toBe('test-user');
      expect(result.evaluatedAt).toBeDefined();
    });

    it('defaults evaluator to system', () => {
      const result = evaluateAgent({ agentId: 'agent-1', score: 90, categories: {} });
      expect(result.evaluator).toBe('system');
    });

    it('includes categories in result', () => {
      const categories = { hierarchy: 4, injection: 5, toolScope: 3 };
      const result = evaluateAgent({ agentId: 'agent-1', score: 80, categories });
      expect(result.categories).toEqual(categories);
    });
  });

  describe('batchEvaluate', () => {
    it('evaluates multiple agents', () => {
      const results = batchEvaluate([
        { agentId: 'a1', score: 90, categories: {} },
        { agentId: 'a2', score: 40, categories: {} },
        { agentId: 'a3', score: 60, categories: {} },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].verdict).toBe('approved');
      expect(results[1].verdict).toBe('rejected');
      expect(results[2].verdict).toBe('pending_review');
    });

    it('handles empty array', () => {
      const results = batchEvaluate([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('summarizeEvaluations', () => {
    it('summarizes results correctly', () => {
      const results = batchEvaluate([
        { agentId: 'a1', score: 90, categories: {} },
        { agentId: 'a2', score: 80, categories: {} },
        { agentId: 'a3', score: 40, categories: {} },
        { agentId: 'a4', score: 60, categories: {} },
      ]);
      const summary = summarizeEvaluations(results);
      expect(summary.total).toBe(4);
      expect(summary.approved).toBe(2);
      expect(summary.rejected).toBe(1);
      expect(summary.pendingReview).toBe(1);
      expect(summary.averageScore).toBe(67.5);
    });

    it('handles empty results', () => {
      const summary = summarizeEvaluations([]);
      expect(summary.total).toBe(0);
      expect(summary.averageScore).toBe(0);
    });
  });
});
