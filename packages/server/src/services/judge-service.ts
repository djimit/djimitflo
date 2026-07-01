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
}

interface JudgeRow {
  id: string;
  verdict_json: string;
  created_at: string;
}

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
  }

  evaluate(answers: ExpertAnswer[]): JudgeVerdict {
    if (answers.length === 0) {
      return this.emptyVerdict();
    }

    const evidenceScore = this.scoreEvidence(answers) * 0.3;
    const sourceScore = this.scoreSources(answers) * 0.2;
    const consistencyScore = this.scoreConsistency(answers) * 0.3;
    const uncertaintyPenalty = this.scoreUncertainty(answers) * 0.2;

    const rawScore = evidenceScore + sourceScore + consistencyScore - uncertaintyPenalty;
    const score = Math.max(0, Math.min(100, rawScore));

    const contradictions = this.findContradictions(answers);
    const recommendations = this.generateRecommendations(answers, score, contradictions);
    const verificationStatus = this.determineVerification(score, contradictions, answers);

    const verdict: JudgeVerdict = {
      id: randomUUID(),
      score: Math.round(score),
      confidence: this.calculateConfidence(answers),
      reasoning: this.generateReasoning(answers, score, evidenceScore, sourceScore, consistencyScore, uncertaintyPenalty),
      contradictions,
      recommendations,
      verification_status: verificationStatus,
      created_at: new Date().toISOString(),
    };

    this.db.prepare('INSERT INTO judge_verdicts (id, verdict_json) VALUES (?, ?)').run(verdict.id, JSON.stringify(verdict));

    return verdict;
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
      const evidenceRefs = answer.evidence_refs?.length ?? 0;
      if (evidenceRefs >= 3) total += 90;
      else if (evidenceRefs >= 1) total += 70;
      else if (answer.content.length > 200) total += 50;
      else total += 30;
    }
    return total / answers.length;
  }

  private scoreSources(answers: ExpertAnswer[]): number {
    const weights: Record<string, number> = {
      arxiv: 0.9,
      wikipedia: 0.7,
      okf: 0.6,
      djimitkb: 0.5,
    };

    let total = 0;
    for (const answer of answers) {
      total += (weights[answer.source] ?? 0.2) * 100;
    }
    return total / answers.length;
  }

  private scoreConsistency(answers: ExpertAnswer[]): number {
    if (answers.length < 2) return 70;

    const domains = new Set(answers.map(a => a.domain));
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;

    const uniqueContents = new Set(answers.map(a => a.content.slice(0, 100)));
    const diversityBonus = uniqueContents.size > 1 ? 10 : 0;

    return Math.min(100, avgConfidence * 100 + diversityBonus + (domains.size > 1 ? 10 : 0));
  }

  private scoreUncertainty(answers: ExpertAnswer[]): number {
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    const lowConfidenceCount = answers.filter(a => a.confidence < 0.3).length;

    return (1 - avgConfidence) * 50 + (lowConfidenceCount / answers.length) * 50;
  }

  private findContradictions(answers: ExpertAnswer[]): string[] {
    const contradictions: string[] = [];

    for (let i = 0; i < answers.length; i++) {
      for (let j = i + 1; j < answers.length; j++) {
        const a = answers[i];
        const b = answers[j];

        const aClaims = this.extractClaims(a.content);
        const bClaims = this.extractClaims(b.content);

        for (const claim of aClaims) {
          const opposite = bClaims.find(c => this.areOpposite(claim, c));
          if (opposite) {
            contradictions.push(`Domain '${a.domain}' claims "${claim.slice(0, 40)}..." but '${b.domain}' claims "${opposite.slice(0, 40)}..."`);
          }
        }
      }
    }

    return contradictions.slice(0, 5);
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
    if (contradictions.length >= 1 && score < 70) return 'contradicted';
    return 'unverifiable';
  }

  private calculateConfidence(answers: ExpertAnswer[]): number {
    if (answers.length === 0) return 0;
    const avg = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    const agreementBonus = answers.length >= 3 ? 0.1 : 0;
    return Math.min(1, avg + agreementBonus);
  }

  private generateReasoning(answers: ExpertAnswer[], score: number, evidence: number, source: number, consistency: number, uncertainty: number): string {
    return `Evaluated ${answers.length} expert answer(s). ` +
      `Evidence: ${evidence.toFixed(0)}/30, Source: ${source.toFixed(0)}/20, ` +
      `Consistency: ${consistency.toFixed(0)}/30, Uncertainty penalty: -${uncertainty.toFixed(0)}/20. ` +
      `Final score: ${score.toFixed(0)}/100.`;
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
    };
  }

  private extractClaims(content: string): string[] {
    return content
      .split(/[.!?]/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 200);
  }

  private areOpposite(a: string, b: string): boolean {
    const negators = ['not', 'never', 'no', 'cannot', 'impossible', 'false', 'isn\'t', 'is not', 'does not', 'doesn\'t'];
    const aLower = a.toLowerCase().trim();
    const bLower = b.toLowerCase().trim();

    const aHasNeg = negators.some(n => aLower.includes(` ${n} `) || aLower.startsWith(`${n} `));
    const bHasNeg = negators.some(n => bLower.includes(` ${n} `) || bLower.startsWith(`${n} `));

    if (aHasNeg !== bHasNeg) {
      const cleanNeg = (s: string) => s
        .replace(/\b(not|never|no|cannot|impossible|false|isn't|is not|does not|doesn't)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      const aCore = cleanNeg(aLower);
      const bCore = cleanNeg(bLower);

      if (aCore.length < 5 || bCore.length < 5) return false;

      const similarity = this.wordSimilarity(aCore, bCore);
      return similarity > 0.4;
    }

    return false;
  }

  private wordSimilarity(a: string, b: string): number {
    const aWords = new Set(a.split(/\s+/));
    const bWords = new Set(b.split(/\s+/));
    let intersection = 0;
    for (const word of aWords) {
      if (bWords.has(word)) intersection++;
    }
    const union = aWords.size + bWords.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
