import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface EvaluationScores {
  correctness: number;
  evidence_quality: number;
  completeness: number;
  risk_score: number;
  policy_compliance: number;
}

export interface CouncilEvaluation {
  id: string;
  session_id: string;
  evaluator_model: string;
  candidate_id: string;
  scores: EvaluationScores;
  ranking: string[];
  confidence: number;
  reasoning: string;
  flagged_concerns: string[];
  evidence_refs: string[];
  created_at: string;
}

export interface AggregatedScore {
  candidate_id: string;
  weighted_score: number;
  rank: number;
  scores: EvaluationScores;
  agreement: number;
}

export class StructuredEvaluator {
  constructor(private db: Database) {}

  storeEvaluation(input: {
    session_id: string;
    evaluator_model: string;
    candidate_id: string;
    scores: EvaluationScores;
    ranking: string[];
    confidence: number;
    reasoning: string;
    flagged_concerns?: string[];
    evidence_refs?: string[];
  }): CouncilEvaluation {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO council_evaluations (
        id, session_id, evaluator_model, candidate_id,
        correctness, evidence_quality, completeness, risk_score,
        policy_compliance, reasoning, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id,
      input.evaluator_model,
      input.candidate_id,
      input.scores.correctness,
      input.scores.evidence_quality,
      input.scores.completeness,
      input.scores.risk_score,
      input.scores.policy_compliance,
      input.reasoning,
      input.confidence,
      now,
    );

    return {
      id,
      session_id: input.session_id,
      evaluator_model: input.evaluator_model,
      candidate_id: input.candidate_id,
      scores: input.scores,
      ranking: input.ranking,
      confidence: input.confidence,
      reasoning: input.reasoning,
      flagged_concerns: input.flagged_concerns ?? [],
      evidence_refs: input.evidence_refs ?? [],
      created_at: now,
    };
  }

  getEvaluationsForSession(sessionId: string): CouncilEvaluation[] {
    const rows = this.db.prepare(
      'SELECT * FROM council_evaluations WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as any[];

    return rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      evaluator_model: r.evaluator_model,
      candidate_id: r.candidate_id,
      scores: {
        correctness: r.correctness,
        evidence_quality: r.evidence_quality,
        completeness: r.completeness,
        risk_score: r.risk_score,
        policy_compliance: r.policy_compliance,
      },
      ranking: [],
      confidence: r.confidence,
      reasoning: r.reasoning,
      flagged_concerns: [],
      evidence_refs: [],
      created_at: r.created_at,
    }));
  }

  getEvaluationsForCandidate(sessionId: string, candidateId: string): CouncilEvaluation[] {
    const rows = this.db.prepare(
      'SELECT * FROM council_evaluations WHERE session_id = ? AND candidate_id = ?'
    ).all(sessionId, candidateId) as any[];

    return rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      evaluator_model: r.evaluator_model,
      candidate_id: r.candidate_id,
      scores: {
        correctness: r.correctness,
        evidence_quality: r.evidence_quality,
        completeness: r.completeness,
        risk_score: r.risk_score,
        policy_compliance: r.policy_compliance,
      },
      ranking: [],
      confidence: r.confidence,
      reasoning: r.reasoning,
      flagged_concerns: [],
      evidence_refs: [],
      created_at: r.created_at,
    }));
  }

  aggregateScores(sessionId: string, method: 'borda' | 'weighted_borda' | 'reciprocal_rank_fusion' = 'weighted_borda'): AggregatedScore[] {
    const evaluations = this.getEvaluationsForSession(sessionId);

    if (evaluations.length === 0) return [];

    const candidateIds = [...new Set(evaluations.map(e => e.candidate_id))];
    const aggregated: AggregatedScore[] = [];

    for (const candidateId of candidateIds) {
      const candidateEvals = evaluations.filter(e => e.candidate_id === candidateId);

      if (method === 'borda') {
        aggregated.push(this.bordaAggregate(candidateId, candidateEvals, evaluations));
      } else if (method === 'weighted_borda') {
        aggregated.push(this.weightedBordaAggregate(candidateId, candidateEvals, evaluations));
      } else {
        aggregated.push(this.reciprocalRankFusion(candidateId, candidateEvals, evaluations));
      }
    }

    aggregated.sort((a, b) => b.weighted_score - a.weighted_score);
    aggregated.forEach((a, i) => { a.rank = i + 1; });

    return aggregated;
  }

  calculateDisagreement(sessionId: string): number {
    const evaluations = this.getEvaluationsForSession(sessionId);
    if (evaluations.length < 2) return 0;

    const candidateIds = [...new Set(evaluations.map(e => e.candidate_id))];
    let totalDisagreement = 0;

    for (const candidateId of candidateIds) {
      const scores = evaluations
        .filter(e => e.candidate_id === candidateId)
        .map(e => this.computeCompositeScore(e.scores));

      if (scores.length >= 2) {
        const range = Math.max(...scores) - Math.min(...scores);
        totalDisagreement += range;
      }
    }

    return candidateIds.length > 0
      ? Math.round((totalDisagreement / candidateIds.length) * 100) / 100
      : 0;
  }

  private computeCompositeScore(scores: EvaluationScores): number {
    return (
      scores.correctness * 0.30 +
      scores.evidence_quality * 0.25 +
      scores.completeness * 0.20 +
      scores.risk_score * 0.15 +
      scores.policy_compliance * 0.10
    );
  }

  private bordaAggregate(candidateId: string, candidateEvals: CouncilEvaluation[], _allEvals: CouncilEvaluation[]): AggregatedScore {
    const compositeScores = candidateEvals.map(e => this.computeCompositeScore(e.scores));
    const avgScore = compositeScores.reduce((a, b) => a + b, 0) / compositeScores.length;
    const agreement = this.calculateAgreement(compositeScores);

    return {
      candidate_id: candidateId,
      weighted_score: Math.round(avgScore * 100) / 100,
      rank: 0,
      scores: this.averageScores(candidateEvals.map(e => e.scores)),
      agreement,
    };
  }

  private weightedBordaAggregate(candidateId: string, candidateEvals: CouncilEvaluation[], _allEvals: CouncilEvaluation[]): AggregatedScore {
    let weightedSum = 0;
    let weightTotal = 0;

    for (const eval_ of candidateEvals) {
      const weight = eval_.confidence;
      weightedSum += this.computeCompositeScore(eval_.scores) * weight;
      weightTotal += weight;
    }

    const weightedScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const compositeScores = candidateEvals.map(e => this.computeCompositeScore(e.scores));
    const agreement = this.calculateAgreement(compositeScores);

    return {
      candidate_id: candidateId,
      weighted_score: Math.round(weightedScore * 100) / 100,
      rank: 0,
      scores: this.averageScores(candidateEvals.map(e => e.scores)),
      agreement,
    };
  }

  private reciprocalRankFusion(candidateId: string, candidateEvals: CouncilEvaluation[], allEvals: CouncilEvaluation[]): AggregatedScore {
    const k = 60;
    let rrfScore = 0;

    const rankingsByEvaluator = new Map<string, string[]>();
    for (const eval_ of allEvals) {
      if (!rankingsByEvaluator.has(eval_.evaluator_model)) {
        rankingsByEvaluator.set(eval_.evaluator_model, eval_.ranking);
      }
    }

    for (const [, ranking] of rankingsByEvaluator) {
      const position = ranking.indexOf(candidateId);
      if (position >= 0) {
        rrfScore += 1 / (k + position + 1);
      }
    }

    const compositeScores = candidateEvals.map(e => this.computeCompositeScore(e.scores));
    const agreement = this.calculateAgreement(compositeScores);

    return {
      candidate_id: candidateId,
      weighted_score: Math.round(rrfScore * 1000) / 1000,
      rank: 0,
      scores: this.averageScores(candidateEvals.map(e => e.scores)),
      agreement,
    };
  }

  private averageScores(scores: EvaluationScores[]): EvaluationScores {
    const n = scores.length;
    if (n === 0) return { correctness: 0, evidence_quality: 0, completeness: 0, risk_score: 0, policy_compliance: 0 };
    return {
      correctness: Math.round(scores.reduce((s, sc) => s + sc.correctness, 0) / n * 100) / 100,
      evidence_quality: Math.round(scores.reduce((s, sc) => s + sc.evidence_quality, 0) / n * 100) / 100,
      completeness: Math.round(scores.reduce((s, sc) => s + sc.completeness, 0) / n * 100) / 100,
      risk_score: Math.round(scores.reduce((s, sc) => s + sc.risk_score, 0) / n * 100) / 100,
      policy_compliance: Math.round(scores.reduce((s, sc) => s + sc.policy_compliance, 0) / n * 100) / 100,
    };
  }

  private calculateAgreement(scores: number[]): number {
    if (scores.length < 2) return 1;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    return Math.max(0, Math.round((1 - stdDev / 5) * 100) / 100);
  }
}
