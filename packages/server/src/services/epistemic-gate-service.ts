import type { Database } from 'better-sqlite3';

export type EpistemicGateType = 'source_quality' | 'logical_consistency' | 'perspective_coverage' | 'falsifiability';

export interface EpistemicGateResult {
  name: EpistemicGateType;
  status: 'pass' | 'fail' | 'skipped';
  evidence: string;
  confidence: number;
}

interface ClaimRow {
  id: string;
  status: string;
  contradicts_ref: string | null;
}

interface EdgeRow {
  from_ref: string;
  to_ref: string;
  relation: string;
}

interface PanelRow {
  id: string;
  metadata: string;
}

export class EpistemicGateService {
  constructor(private db: Database) {}

  evaluateSourceQuality(evidenceRefs: string[]): EpistemicGateResult {
    const sources = evidenceRefs.filter(r => r.startsWith('source:') || r.startsWith('citation:'));
    if (sources.length < 2) {
      return { name: 'source_quality', status: 'fail', evidence: 'insufficient_sources: ' + sources.length + ' (min 2)', confidence: 0.9 };
    }
    return { name: 'source_quality', status: 'pass', evidence: 'sources=' + sources.length, confidence: 0.8 };
  }

  evaluateLogicalConsistency(claimRefs: string[]): EpistemicGateResult {
    for (const ref of claimRefs) {
      if (!ref.startsWith('claim:')) continue;
      const claimId = ref.replace('claim:', '');
      const edges = this.db.prepare(
        'SELECT from_ref, to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ? AND relation = ?'
      ).all(claimId, 'contradicts') as EdgeRow[];
      if (edges.length > 0) {
        return { name: 'logical_consistency', status: 'fail', evidence: 'contradiction found: ' + edges[0].to_ref, confidence: 0.85 };
      }
      const claim = this.db.prepare('SELECT id, contradicts_ref FROM swarm_claims WHERE id = ?').get(claimId) as ClaimRow | undefined;
      if (claim?.contradicts_ref) {
        return { name: 'logical_consistency', status: 'fail', evidence: 'claim contradicts: ' + claim.contradicts_ref, confidence: 0.85 };
      }
    }
    return { name: 'logical_consistency', status: 'pass', evidence: 'no contradictions detected', confidence: 0.7 };
  }

  evaluatePerspectiveCoverage(panelIds: string[]): EpistemicGateResult {
    if (panelIds.length === 0) {
      return { name: 'perspective_coverage', status: 'skipped', evidence: 'no panels referenced', confidence: 0.5 };
    }
    const domains = new Set<string>();
    let hasDissent = false;
    for (const panelId of panelIds) {
      const panel = this.db.prepare('SELECT id, metadata FROM specialist_panels WHERE id = ?').get(panelId) as PanelRow | undefined;
      if (!panel) continue;
      try {
        const meta = JSON.parse(panel.metadata || '{}');
        const participants = meta.participants as Array<{ domain?: string; domains?: string[] }> | undefined;
        if (participants) {
          for (const p of participants) {
            const d = p.domain || (p.domains && p.domains[0]);
            if (d) domains.add(d);
          }
        }
        const consensus = meta.consensus as { oppose_count?: number } | undefined;
        if (consensus?.oppose_count && consensus.oppose_count > 0) hasDissent = true;
      } catch { /* skip */ }
    }
    if (domains.size >= 2 || hasDissent) {
      return { name: 'perspective_coverage', status: 'pass', evidence: 'domains=' + domains.size + ', dissent=' + hasDissent, confidence: 0.75 };
    }
    return { name: 'perspective_coverage', status: 'fail', evidence: 'insufficient perspective diversity: domains=' + domains.size, confidence: 0.8 };
  }

  evaluateFalsifiability(deliverable: string, hypothesisIds: string[]): EpistemicGateResult {
    if (hypothesisIds.length > 0) {
      let hasTestable = false;
      for (const hid of hypothesisIds) {
        const h = this.db.prepare('SELECT projection_state FROM swarm_hypotheses WHERE id = ?').get(hid) as { projection_state?: string } | undefined;
        if (h && h.projection_state && h.projection_state !== 'draft') {
          hasTestable = true;
          break;
        }
      }
      if (hasTestable) {
        return { name: 'falsifiability', status: 'pass', evidence: 'linked to ' + hypothesisIds.length + ' hypothesis(es)', confidence: 0.7 };
      }
    }
    const testablePatterns = [
      /(\w+)\s+(causes?|reduces?|increases?|improves?)\s+(\w+)/i,
      /(\d+%\s+(reduction|improvement|increase|decrease))/i,
      /(before|after|with|without)\s+.{10,50}\s+(measured|observed|verified)/i,
      /(if\s+.+then\s+.+)/i,
    ];
    for (const pattern of testablePatterns) {
      if (pattern.test(deliverable)) {
        return { name: 'falsifiability', status: 'pass', evidence: 'testable claim pattern detected', confidence: 0.65 };
      }
    }
    return { name: 'falsifiability', status: 'fail', evidence: 'no testable claims found in deliverable', confidence: 0.6 };
  }

  runAllGates(input: {
    evidenceRefs?: string[];
    claimRefs?: string[];
    panelIds?: string[];
    deliverable?: string;
    hypothesisIds?: string[];
  }): EpistemicGateResult[] {
    return [
      this.evaluateSourceQuality(input.evidenceRefs || []),
      this.evaluateLogicalConsistency(input.claimRefs || []),
      this.evaluatePerspectiveCoverage(input.panelIds || []),
      this.evaluateFalsifiability(input.deliverable || '', input.hypothesisIds || []),
    ];
  }
}
