/**
 * Agent Evaluation Workflow — evaluates agents and tracks verdicts.
 * Constitution v1.1.0 — Agent governance integration.
 */

export interface AgentEvaluationInput {
  agentId: string;
  score: number;  // 0-100
  categories: Record<string, number>;
  evaluator?: string;
}

export interface AgentEvaluationResult {
  agentId: string;
  score: number;
  verdict: 'approved' | 'rejected' | 'pending_review';
  categories: Record<string, number>;
  evaluatedAt: string;
  evaluator: string;
}

const PASS_THRESHOLD = 70;
const REVIEW_RANGE = [50, 70];

export function evaluateAgent(input: AgentEvaluationInput): AgentEvaluationResult {
  let verdict: 'approved' | 'rejected' | 'pending_review';
  if (input.score >= PASS_THRESHOLD) {
    verdict = 'approved';
  } else if (input.score >= REVIEW_RANGE[0] && input.score < REVIEW_RANGE[1]) {
    verdict = 'pending_review';
  } else {
    verdict = 'rejected';
  }

  return {
    agentId: input.agentId,
    score: input.score,
    verdict,
    categories: input.categories,
    evaluatedAt: new Date().toISOString(),
    evaluator: input.evaluator || 'system',
  };
}

export function batchEvaluate(agents: AgentEvaluationInput[]): AgentEvaluationResult[] {
  return agents.map(evaluateAgent);
}

export function summarizeEvaluations(results: AgentEvaluationResult[]): {
  total: number;
  approved: number;
  rejected: number;
  pendingReview: number;
  averageScore: number;
} {
  const total = results.length;
  const approved = results.filter(r => r.verdict === 'approved').length;
  const rejected = results.filter(r => r.verdict === 'rejected').length;
  const pendingReview = results.filter(r => r.verdict === 'pending_review').length;
  const averageScore = total > 0 ? results.reduce((sum, r) => sum + r.score, 0) / total : 0;

  return { total, approved, rejected, pendingReview, averageScore };
}
