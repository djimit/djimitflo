import type { Database } from 'better-sqlite3';
import type { SwarmIntelligenceService } from './swarm-intelligence-service';

export interface Gap {
  domain: string;
  type: 'coverage' | 'confidence' | 'contradiction' | 'competence';
  severity: number;
  description: string;
}

export interface GapReport {
  gapsFound: number;
  published: number;
  gaps: Gap[];
}

interface CapabilityRow {
  id: string;
  status: string;
  metadata: string;
}

interface ClaimRow {
  subject_ref: string;
  freq: number;
}

export class CuriosityService {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private intelligence: SwarmIntelligenceService,
    opts: { intervalMs?: number } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? (Number(process.env.CURIOSITY_SCAN_INTERVAL_MS) || 6 * 3600_000);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.scanForGaps().catch(() => {}); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async scanForGaps(): Promise<GapReport> {
    const gaps: Gap[] = [];
    gaps.push(...this.detectCoverageGaps());
    gaps.push(...this.detectConfidenceGaps());
    gaps.push(...this.detectContradictionGaps());
    gaps.push(...this.detectCompetenceGaps());

    let published = 0;
    for (const gap of gaps) {
      try {
        this.intelligence.createClaim({
          claim: `Knowledge gap: ${gap.description}`,
          claim_type: 'capability',
          subject_ref: gap.domain,
          predicate: 'gap',
          confidence: gap.severity,
          evidence_refs: [],
          created_from: 'curiosity-service',
        });
        published++;
      } catch { /* skip duplicates */ }
    }

    return { gapsFound: gaps.length, published, gaps };
  }

  private detectCoverageGaps(): Gap[] {
    const gaps: Gap[] = [];
    try {
      const domains = this.db.prepare(`
        SELECT subject_ref, COUNT(*) as cnt FROM swarm_claims
        GROUP BY subject_ref HAVING cnt < 3
      `).all() as Array<{ subject_ref: string; cnt: number }>;
      for (const d of domains) {
        gaps.push({
          domain: d.subject_ref,
          type: 'coverage',
          severity: 0.5,
          description: `Only ${d.cnt} claims in domain '${d.subject_ref}' — needs more coverage`,
        });
      }
    } catch { /* best-effort */ }
    return gaps;
  }

  private detectConfidenceGaps(): Gap[] {
    const gaps: Gap[] = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    try {
      const lowConf = this.db.prepare(`
        SELECT subject_ref, AVG(confidence) as avg_conf FROM swarm_claims
        WHERE created_at < ?
        GROUP BY subject_ref HAVING avg_conf < 0.5
      `).all(thirtyDaysAgo) as Array<{ subject_ref: string; avg_conf: number }>;
      for (const lc of lowConf) {
        gaps.push({
          domain: lc.subject_ref,
          type: 'confidence',
          severity: 1 - lc.avg_conf,
          description: `Low confidence (${lc.avg_conf.toFixed(2)}) in domain '${lc.subject_ref}' — needs verification`,
        });
      }
    } catch { /* best-effort */ }
    return gaps;
  }

  private detectContradictionGaps(): Gap[] {
    const gaps: Gap[] = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    try {
      const contradictions = this.db.prepare(`
        SELECT subject_ref, COUNT(*) as cnt FROM swarm_claims
        WHERE status = 'contradicted' AND created_at > ?
        GROUP BY subject_ref
      `).all(sevenDaysAgo) as ClaimRow[];
      for (const c of contradictions) {
        gaps.push({
          domain: c.subject_ref,
          type: 'contradiction',
          severity: Math.min(1, c.freq * 0.3),
          description: `${c.freq} unresolved contradictions in '${c.subject_ref}'`,
        });
      }
    } catch { /* best-effort */ }
    return gaps;
  }

  private detectCompetenceGaps(): Gap[] {
    const gaps: Gap[] = [];
    try {
      const caps = this.db.prepare('SELECT id, status, metadata FROM swarm_capabilities').all() as CapabilityRow[];
      for (const cap of caps) {
        if (cap.status !== 'validated') continue;
        const competence = this.intelligence.measureCompetence(cap.id);
        if (competence.n_runs >= 3 && competence.success_rate < 0.5) {
          gaps.push({
            domain: cap.id,
            type: 'competence',
            severity: 1 - competence.success_rate,
            description: `Low success rate (${(competence.success_rate * 100).toFixed(0)}%) for capability '${cap.id}'`,
          });
        }
      }
    } catch { /* best-effort */ }
    return gaps;
  }
}
