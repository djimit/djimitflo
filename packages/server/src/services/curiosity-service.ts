import type { Database } from 'better-sqlite3';
import type { SwarmIntelligenceService } from './swarm-intelligence-service';
import { SelfImprovementService } from './self-improvement-service';

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
  cnt: number;
}

// Diagnostic claims are outputs of this scanner, never observations feeding it.
const NON_DIAGNOSTIC = "COALESCE(predicate, '') <> 'gap' AND created_from <> 'curiosity-service'";
const ACTIVE_CLAIM = "status IN ('proposed', 'supported', 'promoted', 'review_required') AND invalidated_by IS NULL AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))";

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
    const observations: Array<[Gap['type'], Gap[] | null]> = [
      ['coverage', this.detectCoverageGaps()], ['confidence', this.detectConfidenceGaps()],
      ['contradiction', this.detectContradictionGaps()], ['competence', this.detectCompetenceGaps()],
    ];
    for (const [type, observed] of observations) {
      if (observed === null) continue; // A failed query is not evidence that a signal disappeared.
      gaps.push(...observed);
      const signatures = JSON.stringify(observed.map(gap => JSON.stringify([gap.domain, `Knowledge gap: ${gap.description}`])));
      this.db.prepare(`UPDATE swarm_claims
        SET metadata = json_set(metadata, '$.observed_signal_active', json('false'))
        WHERE predicate = 'gap' AND created_from = 'curiosity-service' AND json_valid(metadata)
          AND json_extract(metadata, '$.gap_type') = ?
          AND COALESCE(json_extract(metadata, '$.observed_signal_active'), 1) <> 0
          AND json_array(subject_ref, claim) NOT IN (SELECT value FROM json_each(?))
      `).run(type, signatures);
    }

    let published = 0;
    for (const gap of gaps) {
      try {
        const claim = `Knowledge gap: ${gap.description}`;
        // Keep continuously observed decisions intact; a disappeared signal can recur as a new candidate.
        const existing = this.db.prepare(`SELECT 1 FROM swarm_claims
          WHERE subject_ref = ? AND claim = ? AND predicate = 'gap' AND created_from = 'curiosity-service'
            AND invalidated_by IS NULL AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))
            AND COALESCE(json_extract(metadata, '$.observed_signal_active'), 1) <> 0
          LIMIT 1`).get(gap.domain, claim);
        if (existing) continue;
        this.intelligence.createClaim({
          claim,
          claim_type: 'capability',
          subject_ref: gap.domain,
          predicate: 'gap',
          confidence: gap.severity,
          evidence_refs: [],
          created_from: 'curiosity-service',
          metadata: { gap_type: gap.type, observed_signal_active: true, ...(gap.type === 'coverage' ? { detection_method: 'count_heuristic', coverage_status: 'UNKNOWN' } : {}) },
        });
        published++;
      } catch { /* skip duplicates */ }
    }

    // Feed real, detected gaps into the reviewed self-improvement pipeline.
    // Found 2026-09-21: generateFromGaps() has existed, tested, unused since
    // before this session — this method's own output only ever reached
    // swarm_claims, never a place that could turn a gap into reviewed work.
    // Wired once here (not at each of scanForGaps()'s two call sites — boot
    // and the periodic interval in start()) so both get it for free.
    // Best-effort: a proposal-generation failure must never block gap
    // detection/publishing above. Fingerprint dedup in createProposal()
    // already prevents a still-open gap re-detected on the next cycle from
    // creating a duplicate proposal.
    try {
      // Coverage gaps come from a count heuristic (coverage UNKNOWN): not an actionable finding, keep them as claims only.
      new SelfImprovementService(this.db).generateFromGaps(gaps.filter(gap => gap.type !== 'coverage'));
    } catch { /* best-effort */ }

    return { gapsFound: gaps.length, published, gaps };
  }

  private detectCoverageGaps(): Gap[] | null {
    const gaps: Gap[] = [];
    try {
      const domains = this.db.prepare(`
        SELECT subject_ref, COUNT(DISTINCT CASE WHEN ${ACTIVE_CLAIM}
          THEN json_array(lower(trim(claim)), COALESCE(predicate, ''), COALESCE(object, ''), COALESCE(scope, '')) END) as cnt
        FROM swarm_claims WHERE ${NON_DIAGNOSTIC}
        GROUP BY subject_ref HAVING cnt < 3
      `).all() as Array<{ subject_ref: string; cnt: number }>;
      for (const d of domains) {
        gaps.push({
          domain: d.subject_ref,
          type: 'coverage',
          severity: 0.5,
          description: `Sparse claim inventory: ${d.cnt} distinct normalized active statements in domain '${d.subject_ref}' (count heuristic < 3; coverage UNKNOWN)`,
        });
      }
    } catch { return null; }
    return gaps;
  }

  private detectConfidenceGaps(): Gap[] | null {
    const gaps: Gap[] = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    try {
      const lowConf = this.db.prepare(`
        SELECT subject_ref, AVG(confidence) as avg_conf FROM swarm_claims
        WHERE datetime(created_at) < datetime(?) AND ${NON_DIAGNOSTIC} AND ${ACTIVE_CLAIM}
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
    } catch { return null; }
    return gaps;
  }

  private detectContradictionGaps(): Gap[] | null {
    const gaps: Gap[] = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    try {
      const contradictions = this.db.prepare(`
        SELECT subject_ref, COUNT(*) as cnt FROM swarm_claims
        WHERE status = 'contradicted' AND datetime(created_at) > datetime(?) AND ${NON_DIAGNOSTIC}
          AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))
        GROUP BY subject_ref
      `).all(sevenDaysAgo) as ClaimRow[];
      for (const c of contradictions) {
        gaps.push({
          domain: c.subject_ref,
          type: 'contradiction',
          severity: Math.min(1, c.cnt * 0.3),
          description: `${c.cnt} unresolved contradictions in '${c.subject_ref}'`,
        });
      }
    } catch { return null; }
    return gaps;
  }

  private detectCompetenceGaps(): Gap[] | null {
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
    } catch { return null; }
    return gaps;
  }
}
