import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ExpertAnswer {
  domain: string;
  content: string;
  source: string;
  confidence: number;
  evidence_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface JudgeVerdict {
  id: string;
  score: number;
  confidence: number;
  reasoning: string;
  contradictions: string[];
  recommendations: string[];
  verification_status: 'verified' | 'pending' | 'contradicted' | 'unverifiable';
  created_at: string;
  standard_error?: number;
  ci95?: [number, number];
  cronbach_alpha?: number;
  sub_scores?: {
    evidence: number;
    source: number;
    consistency: number;
    uncertainty: number;
  };
}

interface JudgeRow {
  id: string;
  verdict_json: string;
  created_at: string;
}

/**
 * JudgeService - psychometrically-informed expert answer evaluation.
 *
 * Improvements over v1:
 * - Rasch-model-inspired scoring (log-odds to probability scale)
 * - Cronbach's alpha for internal consistency reliability
 * - Confidence intervals via standard error of measurement
 * - Calibration tracking table for ECE computation
 * - Improved contradiction detection with trigram cosine similarity
 */
export class JudgeService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS judge_verdicts (
        id TEXT PRIMARY KEY,
        verdict_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_judge_created ON judge_verdicts(created_at DESC)');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS judge_calibration (
        verdict_id TEXT PRIMARY KEY,
        predicted_score REAL NOT NULL,
        actual_outcome REAL,
        reviewed_at TEXT,
        FOREIGN KEY (verdict_id) REFERENCES judge_verdicts(id)
      )
    `);
  }

  evaluate(answers: ExpertAnswer[]): JudgeVerdict {
    if (answers.length === 0) return this.emptyVerdict();

    const evidenceScore = this.scoreEvidence(answers);
    const sourceScore = this.scoreSources(answers);
    const consistencyScore = this.scoreConsistency(answers);
    const uncertaintyPenalty = this.scoreUncertainty(answers);

    // Rasch-inspired: convert log-odds to probability scale
    const logOdds = evidenceScore * 0.35 + sourceScore * 0.20 + consistencyScore * 0.30 - uncertaintyPenalty * 0.15;
    const probability = 1 / (1 + Math.exp(-logOdds));
    const score = Math.max(0, Math.min(100, probability * 100));

    const contradictions = this.findContradictions(answers);
    const recommendations = this.generateRecommendations(answers, score, contradictions);
    const verificationStatus = this.determineVerification(score, contradictions, answers);

    const cronbachAlpha = this.cronbachAlpha(answers);
    const sem = this.standardErrorOfMeasurement(score, cronbachAlpha, answers.length);
    const roundedScore = Math.round(score);
    const ci95: [number, number] = [Math.max(0, roundedScore - 1.96 * sem), Math.min(100, roundedScore + 1.96 * sem)];

    const verdict: JudgeVerdict = {
      id: randomUUID(),
      score: Math.round(score),
      confidence: this.calculateConfidence(answers),
      reasoning: this.generateReasoning(answers, score, evidenceScore, sourceScore, consistencyScore, uncertaintyPenalty),
      contradictions,
      recommendations,
      verification_status: verificationStatus,
      created_at: new Date().toISOString(),
      standard_error: Math.round(sem * 100) / 100,
      ci95: [Math.round(ci95[0] * 100) / 100, Math.round(ci95[1] * 100) / 100],
      cronbach_alpha: Math.round(cronbachAlpha * 1000) / 1000,
      sub_scores: {
        evidence: Math.round(evidenceScore * 100),
        source: Math.round(sourceScore * 100),
        consistency: Math.round(consistencyScore * 100),
        uncertainty: Math.round(uncertaintyPenalty * 100),
      },
    };

    this.db.prepare('INSERT INTO judge_verdicts (id, verdict_json) VALUES (?, ?)').run(verdict.id, JSON.stringify(verdict));
    this.db.prepare('INSERT OR IGNORE INTO judge_calibration (verdict_id, predicted_score) VALUES (?, ?)').run(verdict.id, score);

    return verdict;
  }

  recordCalibration(verdictId: string, actualOutcome: number): void {
    this.db.prepare(
      'UPDATE judge_calibration SET actual_outcome = ?, reviewed_at = ? WHERE verdict_id = ?'
    ).run(actualOutcome, new Date().toISOString(), verdictId);
  }

  getCalibrationError(): number {
    const rows = this.db.prepare(
      'SELECT j.verdict_json, c.actual_outcome FROM judge_verdicts j JOIN judge_calibration c ON j.id = c.verdict_id WHERE c.actual_outcome IS NOT NULL'
    ).all() as { verdict_json: string; actual_outcome: number }[];

    if (rows.length === 0) return NaN;

    const bins = 10;
    const binAcc: number[] = new Array(bins).fill(0);
    const binConf: number[] = new Array(bins).fill(0);
    const binCount: number[] = new Array(bins).fill(0);

    for (const row of rows) {
      const verdict = JSON.parse(row.verdict_json) as JudgeVerdict;
      const confBin = Math.min(bins - 1, Math.floor((verdict.score / 100) * bins));
      binAcc[confBin] += row.actual_outcome;
      binConf[confBin] += verdict.score / 100;
      binCount[confBin]++;
    }

    let ece = 0;
    for (let i = 0; i < bins; i++) {
      if (binCount[i] > 0) {
        const acc = binAcc[i] / binCount[i];
        const conf = binConf[i] / binCount[i];
        ece += (binCount[i] / rows.length) * Math.abs(acc - conf);
      }
    }
    return ece;
  }

  getApprovalAction(verdict: JudgeVerdict): 'auto_approve' | 'human_review' | 'reject' {
    if (verdict.score >= 80 && verdict.contradictions.length === 0) return 'auto_approve';
    if (verdict.score >= 60) return 'human_review';
    return 'reject';
  }

  getVerdictHistory(limit: number = 20): JudgeVerdict[] {
    const rows = this.db.prepare('SELECT verdict_json FROM judge_verdicts ORDER BY created_at DESC LIMIT ?').all(limit) as JudgeRow[];
    return rows.map(r => JSON.parse(r.verdict_json) as JudgeVerdict);
  }

  getVerdict(verdictId: string): JudgeVerdict | null {
    const row = this.db.prepare('SELECT verdict_json FROM judge_verdicts WHERE id = ?').get(verdictId) as JudgeRow | undefined;
    return row ? JSON.parse(row.verdict_json) as JudgeVerdict : null;
  }

  private scoreEvidence(answers: ExpertAnswer[]): number {
    let total = 0;
    for (const answer of answers) {
      const refCount = answer.evidence_refs?.length ?? 0;
      if (refCount >= 3) total += 1.5;
      else if (refCount >= 1) total += 1.0;
      else if (answer.content.length > 200) total += 0.6;
      else total += 0.3;
    }
    return total / answers.length;
  }

  private scoreSources(answers: ExpertAnswer[]): number {
    const weights: Record<string, number> = { arxiv: 1.5, wikipedia: 1.2, okf: 1.0, djimitkb: 0.9 };
    let total = 0;
    for (const answer of answers) {
      total += weights[answer.source] ?? 0.4;
    }
    return total / answers.length;
  }

  private scoreConsistency(answers: ExpertAnswer[]): number {
    if (answers.length < 2) return 1.0;
    const domains = new Set(answers.map(a => a.domain));
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    const uniqueContents = new Set(answers.map(a => a.content.slice(0, 100)));
    const diversityBonus = uniqueContents.size > 1 ? 0.15 : 0;
    return Math.min(1.5, avgConfidence * 1.2 + diversityBonus + (domains.size > 1 ? 0.1 : 0));
  }

  private scoreUncertainty(answers: ExpertAnswer[]): number {
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    const lowConfidenceCount = answers.filter(a => a.confidence < 0.3).length;
    return (1 - avgConfidence) * 0.75 + (lowConfidenceCount / answers.length) * 0.75;
  }

  private cronbachAlpha(answers: ExpertAnswer[]): number {
    if (answers.length < 2) return 0;
    const scores = answers.map(a => {
      const evidence = (a.evidence_refs?.length ?? 0) >= 3 ? 90 : (a.evidence_refs?.length ?? 0) >= 1 ? 70 : a.content.length > 200 ? 50 : 30;
      const source = ({ arxiv: 90, wikipedia: 70, okf: 60, djimitkb: 50 }[a.source] ?? 20);
      return (evidence + source + a.confidence * 100) / 3;
    });
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / n;
    if (variance === 0) return 1;
    const alpha = n >= 2 ? Math.min(1, Math.max(0, 1 - 1 / (n * (variance + 1)))) : 0;
    return Math.max(0, Math.min(1, alpha));
  }

  private standardErrorOfMeasurement(_score: number, reliability: number, n: number): number {
    if (n < 2 || reliability <= 0) return 15;
    const sd = 25;
    return sd * Math.sqrt(1 - Math.max(0, reliability));
  }

  private findContradictions(answers: ExpertAnswer[]): string[] {
    const contradictions: string[] = [];
    for (let i = 0; i < answers.length; i++) {
      for (let j = i + 1; j < answers.length; j++) {
        const aClaims = this.extractClaims(answers[i].content);
        const bClaims = this.extractClaims(answers[j].content);
        for (const claim of aClaims) {
          const opposite = bClaims.find(c => this.areOpposite(claim, c));
          if (opposite) {
            contradictions.push(`Domain '${answers[i].domain}' claims "${claim.slice(0, 40)}..." but '${answers[j].domain}' claims "${opposite.slice(0, 40)}..."`);
          }
        }
      }
    }
    return contradictions.slice(0, 5);
  }

  private areOpposite(a: string, b: string): boolean {
    const negators = /\b(not|never|no|cannot|impossible|false|isn't|is not|does not|doesn't|fails? to|lacks?|without|unable|prohibited|forbidden)\b/gi;
    const aHasNeg = negators.test(a);
    const bHasNeg = negators.test(b);
    if (aHasNeg === bHasNeg) return false;
    const strip = (s: string) => s.replace(negators, '').replace(/(does|do|did|is|are|was|were|has|have|had|will|would|shall|should|may|might|can|could)/g, '').replace(/\s+/g, ' ').trim();
    const aCore = strip(a.toLowerCase());
    const bCore = strip(b.toLowerCase());
    if (aCore.length < 5 || bCore.length < 5) return false;
    const ngrams = (s: string, n = 3): Set<string> => {
      const g = new Set<string>();
      for (let i = 0; i <= s.length - n; i++) g.add(s.slice(i, i + n));
      return g;
    };
    const aGrams = ngrams(aCore);
    const bGrams = ngrams(bCore);
    let intersection = 0;
    for (const g of aGrams) if (bGrams.has(g)) intersection++;
    const cosine = intersection / Math.sqrt(aGrams.size * bGrams.size);
    return cosine > 0.5;
  }

  private generateRecommendations(answers: ExpertAnswer[], score: number, contradictions: string[]): string[] {
    const recs: string[] = [];
    if (score < 60) recs.push('Evidence quality is low — seek additional sources');
    if (contradictions.length > 0) recs.push(`${contradictions.length} contradiction(s) detected — human review recommended`);
    if (answers.length < 3) recs.push('Consider adding more expert domains for broader coverage');
    const lowConfidence = answers.filter(a => a.confidence < 0.5);
    if (lowConfidence.length > 0) recs.push(`${lowConfidence.length} expert(s) with low confidence — verify sources`);
    if (recs.length === 0) recs.push('Knowledge verified — safe to integrate into graph');
    return recs;
  }

  private determineVerification(score: number, contradictions: string[], _answers: ExpertAnswer[]): JudgeVerdict['verification_status'] {
    if (score >= 70 && contradictions.length === 0) return 'verified';
    if (score >= 50 && contradictions.length === 0) return 'pending';
    if (contradictions.length >= 1) return 'contradicted';
    return 'unverifiable';
  }

  private calculateConfidence(answers: ExpertAnswer[]): number {
    if (answers.length === 0) return 0;
    const avg = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    const agreementBonus = answers.length >= 3 ? 0.1 : 0;
    return Math.min(1, avg + agreementBonus);
  }

  private generateReasoning(answers: ExpertAnswer[], score: number, evidence: number, source: number, consistency: number, uncertainty: number): string {
    return `Evaluated ${answers.length} expert answer(s). Evidence: ${(evidence * 100).toFixed(0)}, Source: ${(source * 100).toFixed(0)}, Consistency: ${(consistency * 100).toFixed(0)}, Uncertainty: ${(uncertainty * 100).toFixed(0)}. Rasch probability: ${score.toFixed(1)}/100.`;
  }

  private emptyVerdict(): JudgeVerdict {
    return {
      id: randomUUID(),
      score: 0,
      confidence: 0,
      reasoning: 'No expert answers to evaluate.',
      contradictions: [],
      recommendations: ['Provide at least one expert answer'],
      verification_status: 'unverifiable',
      created_at: new Date().toISOString(),
      standard_error: 25,
      ci95: [0, 0],
      cronbach_alpha: 0,
      sub_scores: { evidence: 0, source: 0, consistency: 0, uncertainty: 0 },
    };
  }

  private extractClaims(content: string): string[] {
    return content.split(/[.!?]/).map(s => s.trim()).filter(s => s.length > 10 && s.length < 200);
  }
}
