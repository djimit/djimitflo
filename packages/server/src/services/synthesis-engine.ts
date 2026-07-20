import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { AggregatedScore } from './structured-evaluator';

export interface SynthesisInput {
  session_id: string;
  task_description: string;
  aggregated_scores: AggregatedScore[];
  outputs: Array<{ anonymous_id: string; content: string; model: string }>;
  evaluations: Array<{ candidate_id: string; reasoning: string; scores: any }>;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  disagreement_score: number;
}

export interface SynthesisResult {
  id: string;
  session_id: string;
  output: string;
  method: string;
  confidence: number;
  top_candidate: string;
  minority_views: string[];
  uncertainty_statements: string[];
  evidence_refs: string[];
  policy_flags: string[];
  created_at: string;
}

export class SynthesisEngine {
  constructor(private db: Database) {}

  synthesize(input: SynthesisInput): SynthesisResult {
    const id = randomUUID();
    const now = new Date().toISOString();

    const topCandidate = input.aggregated_scores[0];
    const minorityViews = this.extractMinorityViews(input.aggregated_scores);
    const uncertaintyStatements = this.generateUncertaintyStatements(input);
    const policyFlags = this.identifyPolicyFlags(input);

    const output = this.buildStructuredOutput(input, topCandidate, minorityViews, uncertaintyStatements);

    const confidence = this.calculateOverallConfidence(input, topCandidate);
    const evidenceRefs = this.extractEvidenceRefs(input);

    const result: SynthesisResult = {
      id,
      session_id: input.session_id,
      output: JSON.stringify(output, null, 2),
      method: 'weighted_borda',
      confidence,
      top_candidate: topCandidate?.candidate_id ?? 'none',
      minority_views: minorityViews,
      uncertainty_statements: uncertaintyStatements,
      evidence_refs: evidenceRefs,
      policy_flags: policyFlags,
      created_at: now,
    };

    this.storeAggregation(input.session_id, result);

    return result;
  }

  private buildStructuredOutput(
    input: SynthesisInput,
    topCandidate: AggregatedScore | undefined,
    minorityViews: string[],
    uncertaintyStatements: string[],
  ): Record<string, unknown> {
    return {
      conclusion: topCandidate
        ? `Top-ranked candidate: ${topCandidate.candidate_id} (score: ${topCandidate.weighted_score})`
        : 'No consensus reached',
      confidence: this.calculateOverallConfidence(input, topCandidate),
      reasoning: {
        method: 'Weighted Borda Count',
        model_count: input.outputs.length,
        evaluator_count: input.evaluations.length,
        disagreement_score: input.disagreement_score,
      },
      top_ranked: input.aggregated_scores.slice(0, 3).map(s => ({
        candidate: s.candidate_id,
        score: s.weighted_score,
        agreement: s.agreement,
        sub_scores: s.scores,
      })),
      minority_views: minorityViews,
      uncertainty: uncertaintyStatements,
      policy_flags: this.identifyPolicyFlags(input),
      evidence_refs: this.extractEvidenceRefs(input),
      requires_human_review: input.risk_class === 'critical' || input.disagreement_score > 2,
    };
  }

  private extractMinorityViews(aggregated: AggregatedScore[]): string[] {
    if (aggregated.length < 2) return [];
    const top = aggregated[0];
    const minorities = aggregated.filter(a => a.rank > 2 && a.weighted_score > top.weighted_score * 0.7);
    return minorities.map(m => `Candidate ${m.candidate_id} scored ${m.weighted_score} with ${Math.round(m.agreement * 100)}% agreement`);
  }

  private generateUncertaintyStatements(input: SynthesisInput): string[] {
    const statements: string[] = [];

    if (input.disagreement_score > 2) {
      statements.push(`High inter-evaluator disagreement (${input.disagreement_score.toFixed(2)})`);
    }

    if (input.aggregated_scores.length >= 2) {
      const gap = input.aggregated_scores[0].weighted_score - input.aggregated_scores[1].weighted_score;
      if (gap < 0.5) {
        statements.push(`Narrow margin between top candidates (${gap.toFixed(2)})`);
      }
    }

    if (input.risk_class === 'critical') {
      statements.push('Critical risk classification requires human verification');
    }

    return statements;
  }

  private identifyPolicyFlags(input: SynthesisInput): string[] {
    const flags: string[] = [];

    if (input.risk_class === 'critical') {
      flags.push('CRITICAL_RISK: Human approval mandatory');
    }

    if (input.disagreement_score > 3) {
      flags.push('HIGH_DISAGREEMENT: Results unreliable without human review');
    }

    const lowEvidenceScores = input.evaluations.filter(e => e.scores.evidence_quality < 2);
    if (lowEvidenceScores.length > input.evaluations.length / 2) {
      flags.push('LOW_EVIDENCE: Majority of evaluations cite poor evidence quality');
    }

    return flags;
  }

  private extractEvidenceRefs(input: SynthesisInput): string[] {
    const refs = new Set<string>();
    for (const eval_ of input.evaluations) {
      if (eval_.reasoning && eval_.reasoning.length > 10) {
        refs.add(`${eval_.candidate_id}: ${eval_.reasoning.slice(0, 100)}`);
      }
    }
    return [...refs];
  }

  private calculateOverallConfidence(input: SynthesisInput, topCandidate?: AggregatedScore): number {
    if (!topCandidate) return 0;

    const baseConfidence = topCandidate.weighted_score / 5;
    const agreementFactor = topCandidate.agreement;
    const disagreementPenalty = Math.min(0.5, input.disagreement_score / 10);

    return Math.round(Math.max(0, Math.min(1, baseConfidence * agreementFactor - disagreementPenalty)) * 100) / 100;
  }

  private storeAggregation(sessionId: string, result: SynthesisResult): void {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO council_aggregations (id, session_id, method, rankings, final_scores, disagreement_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      result.method,
      JSON.stringify(result.top_candidate),
      JSON.stringify({ confidence: result.confidence, minority_views: result.minority_views }),
      0,
      result.created_at,
    );
  }
}
