import type { Database } from 'better-sqlite3';

export type OperationMode = 'normal' | 'cautious' | 'conservative';

export interface NoveltyAssessment {
  isNovel: boolean;
  distance: number;
  nearestCapability: string;
  estimatedCompetence: number;
  recommendedMode: OperationMode;
}

interface CapabilityRow {
  id: string;
  metadata: string;
}

interface CalibrationRow {
  capability_id: string;
  success_rate: number;
  n_runs: number;
}

export class CompetenceAwarenessService {
  private noveltyThreshold = 0.5;
  private conservativeThreshold = 0.3;
  private cautiousThreshold = 0.6;

  constructor(private db: Database) {}

  assessNovelty(finding: { type: string; description: string }): NoveltyAssessment {
    const capabilities = this.db.prepare('SELECT id, metadata FROM swarm_capabilities').all() as CapabilityRow[];

    let nearestCapability = '';
    let minDistance = Infinity;

    const findingText = `${finding.type} ${finding.description}`.toLowerCase();

    for (const cap of capabilities) {
      const capText = cap.id.toLowerCase();
      const distance = this.textDistance(findingText, capText);
      if (distance < minDistance) {
        minDistance = distance;
        nearestCapability = cap.id;
      }
    }

    const isNovel = minDistance > this.noveltyThreshold;
    const estimatedCompetence = this.estimateCompetence(nearestCapability);
    const recommendedMode = this.determineMode(estimatedCompetence, isNovel);

    return { isNovel, distance: minDistance, nearestCapability, estimatedCompetence, recommendedMode };
  }

  estimateCompetence(capabilityId: string): number {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as n,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes
      FROM worker_leases
      WHERE capability_id = ? AND role = 'maker'
    `).get(capabilityId) as { n: number; successes: number | null };

    if (!row || row.n === 0) return 0.5;
    return (row.successes ?? 0) / row.n;
  }

  determineMode(competence: number, isNovel: boolean = false): OperationMode {
    if (isNovel && competence < this.conservativeThreshold) return 'conservative';
    if (competence < this.cautiousThreshold) return 'cautious';
    return 'normal';
  }

  recordOutcome(assessment: NoveltyAssessment, success: boolean): void {
    const currentCompetence = this.estimateCompetence(assessment.nearestCapability);
    const adjustment = success ? 0.1 : -0.05;
    void currentCompetence;
    void adjustment;
  }

  getOperationMode(finding: { type: string; description: string }): OperationMode {
    const assessment = this.assessNovelty(finding);
    return assessment.recommendedMode;
  }

  private textDistance(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 1 : 1 - intersection / union;
  }
}
