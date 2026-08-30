import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SpecialistPanelService } from './specialist-panel-service';

export type ImprovementStatus = 'proposed' | 'scheduled' | 'executing' | 'verified' | 'evaluating' | 'applied' | 'rejected' | 'no_change' | 'regressed';

export interface ImprovementProposal {
  id: string;
  type: 'bug_fix' | 'feature' | 'refactor' | 'performance' | 'security';
  title: string;
  description: string;
  rationale: string;
  source: 'reflection' | 'invention' | 'gap_analysis' | 'feedback';
  status: ImprovementStatus;
  priority: number;
  evidenceRefs: string[];
  panelId: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImprovementRow {
  id: string; type: string; title: string; description: string; rationale: string;
  source: string; status: string; priority: number; evidence_refs_json?: string;
  panel_id?: string | null; approved_by?: string | null; created_at: string; updated_at?: string | null;
}

type ProposalInput = Pick<ImprovementProposal, 'type' | 'title' | 'description' | 'rationale' | 'source' | 'priority'> & {
  evidenceRefs?: string[];
};

export class SelfImprovementService {
  private panels: SpecialistPanelService;

  constructor(private db: Database) {
    this.panels = new SpecialistPanelService(db);
  }

  generateFromReflection(reflection: {
    whatFailed: string[];
    lessonsLearned: string[];
    proposedImprovements: string[];
    loopRunId?: string;
    reflectionId?: string;
  }): ImprovementProposal[] {
    const evidenceRefs = [
      reflection.loopRunId && `loop:${reflection.loopRunId}`,
      reflection.reflectionId && `reflection:${reflection.reflectionId}`,
    ].filter((ref): ref is string => Boolean(ref));
    return reflection.proposedImprovements.flatMap((description) => {
      const type = this.classifyImprovement(description);
      const proposal = this.createProposal({
        type,
        title: description.slice(0, 80),
        description,
        rationale: reflection.lessonsLearned.join('; ') || 'Generated from reflection',
        source: 'reflection',
        priority: type === 'bug_fix' ? 0.9 : type === 'security' ? 0.95 : 0.6,
        evidenceRefs,
      });
      return proposal ? [proposal] : [];
    });
  }

  generateFromGaps(gaps: Array<{ domain: string; description: string }>): ImprovementProposal[] {
    return gaps.flatMap((gap) => {
      const proposal = this.createProposal({
        type: 'feature',
        title: `Address knowledge gap: ${gap.domain}`,
        description: gap.description,
        rationale: `Knowledge gap identified in domain '${gap.domain}'`,
        source: 'gap_analysis',
        priority: 0.7,
        evidenceRefs: [`knowledge-gap:${gap.domain}`],
      });
      return proposal ? [proposal] : [];
    });
  }

  generateFromBuildErrors(errors: string[]): ImprovementProposal[] {
    return errors.slice(0, 5).flatMap((error) => {
      const proposal = this.createProposal({
        type: 'bug_fix',
        title: `Fix: ${error.slice(0, 60)}`,
        description: error,
        rationale: 'Build/test failure detected',
        source: 'feedback',
        priority: 0.95,
        evidenceRefs: ['build:test-failure'],
      });
      return proposal ? [proposal] : [];
    });
  }

  listImprovements(status?: ImprovementStatus, limit = 100): ImprovementProposal[] {
    const normalizedLimit = Math.max(1, Math.min(Number(limit || 100), 500));
    const rows = status
      ? this.db.prepare('SELECT * FROM self_improvements WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ?').all(status, normalizedLimit)
      : this.db.prepare('SELECT * FROM self_improvements ORDER BY created_at DESC LIMIT ?').all(normalizedLimit);
    return (rows as ImprovementRow[]).map((row) => this.rowToProposal(row));
  }

  getImprovement(id: string): ImprovementProposal {
    const row = this.db.prepare('SELECT * FROM self_improvements WHERE id = ?').get(id) as ImprovementRow | undefined;
    if (!row) throw new Error('SELF_IMPROVEMENT_NOT_FOUND');
    return this.rowToProposal(row);
  }

  getProposedImprovements(): ImprovementProposal[] {
    return this.listImprovements('proposed');
  }

  getImprovementHistory(limit = 20): ImprovementProposal[] {
    return this.listImprovements(undefined, limit);
  }

  approveImprovement(id: string, approvedBy: string): ImprovementProposal {
    if (!approvedBy.trim()) throw new Error('SELF_IMPROVEMENT_OPERATOR_REQUIRED');
    const proposal = this.getImprovement(id);
    if (proposal.status !== 'proposed') throw new Error('SELF_IMPROVEMENT_NOT_PROPOSED');
    if (!proposal.panelId) throw new Error('SELF_IMPROVEMENT_PANEL_REQUIRED');
    const panel = this.panels.getPanel(proposal.panelId);
    if (panel.status !== 'consensus_ready' || panel.consensus.decision !== 'goal') {
      throw new Error('SELF_IMPROVEMENT_CONSENSUS_REQUIRED');
    }
    const reviewerActors = (this.db.prepare('SELECT reviewer_actor FROM specialist_reviews WHERE panel_id = ?').all(panel.id) as Array<{ reviewer_actor?: string }>)
      .map((review) => review.reviewer_actor)
      .filter(Boolean);
    if (reviewerActors.includes(approvedBy)) throw new Error('SELF_IMPROVEMENT_OPERATOR_SEPARATION_REQUIRED');
    const now = new Date().toISOString();
    this.db.prepare("UPDATE self_improvements SET status = 'scheduled', approved_by = ?, updated_at = ? WHERE id = ?")
      .run(approvedBy, now, id);
    this.db.prepare("UPDATE specialist_panels SET status = 'goal_created', updated_at = ? WHERE id = ?")
      .run(now, panel.id);
    return this.getImprovement(id);
  }

  completeImprovement(id: string): void {
    if (this.getImprovement(id).status !== 'evaluating') throw new Error('SELF_IMPROVEMENT_NOT_EVALUATING');
    this.transition(id, 'applied');
  }

  rejectImprovement(id: string): ImprovementProposal {
    const proposal = this.getImprovement(id);
    if (!['proposed', 'scheduled'].includes(proposal.status)) throw new Error('SELF_IMPROVEMENT_CLOSED');
    this.db.transaction(() => {
      this.transition(id, 'rejected');
      if (proposal.panelId) {
        this.db.prepare("UPDATE specialist_panels SET status = 'cancelled', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), proposal.panelId);
      }
    })();
    return this.getImprovement(id);
  }

  private createProposal(input: ProposalInput): ImprovementProposal | null {
    const fingerprint = createHash('sha256')
      .update(`${input.source}\0${input.title.trim().toLowerCase()}\0${input.description.trim().toLowerCase()}`)
      .digest('hex');
    const duplicate = this.db.prepare(
      "SELECT id FROM self_improvements WHERE fingerprint = ? AND status IN ('proposed', 'scheduled', 'executing', 'verified', 'evaluating') LIMIT 1"
    ).get(fingerprint) as { id: string } | undefined;
    if (duplicate) return null;

    const id = randomUUID();
    const now = new Date().toISOString();
    const evidenceRefs = Array.from(new Set(input.evidenceRefs || []));
    const riskClass = input.type === 'security' ? 'high' : 'low';
    const specialistIds = input.type === 'security'
      ? ['systems_architect', 'security_reviewer']
      : ['systems_architect', 'runtime_engineer'];

    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO self_improvements (
          id, type, title, description, rationale, source, status, priority,
          fingerprint, evidence_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)
      `).run(id, input.type, input.title, input.description, input.rationale, input.source, input.priority, fingerprint, JSON.stringify(evidenceRefs), now, now);
      const panel = this.panels.createPanel({
        topic: input.title,
        question: `Should self-improvement proposal ${id} be authorized as a goal?`,
        risk_class: riskClass,
        specialist_ids: specialistIds,
        context: { proposal_id: id, description: input.description, rationale: input.rationale, evidence_refs: evidenceRefs },
        metadata: { self_improvement_id: id },
      });
      this.db.prepare('UPDATE self_improvements SET panel_id = ? WHERE id = ?').run(panel.id, id);
    });
    create();
    return this.getImprovement(id);
  }

  private transition(id: string, status: ImprovementStatus): void {
    const result = this.db.prepare('UPDATE self_improvements SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    if (result.changes === 0) throw new Error('SELF_IMPROVEMENT_NOT_FOUND');
  }

  private classifyImprovement(text: string): ImprovementProposal['type'] {
    const lower = text.toLowerCase();
    if (lower.includes('security') || lower.includes('vulnerability')) return 'security';
    if (lower.includes('performance') || lower.includes('slow') || lower.includes('optimize')) return 'performance';
    if (lower.includes('refactor') || lower.includes('cleanup') || lower.includes('restructure')) return 'refactor';
    if (lower.includes('fix') || lower.includes('bug') || lower.includes('error') || lower.includes('handle') || lower.includes('catch') || lower.includes('resolve')) return 'bug_fix';
    return 'feature';
  }

  private rowToProposal(row: ImprovementRow): ImprovementProposal {
    return {
      id: row.id,
      type: row.type as ImprovementProposal['type'],
      title: row.title,
      description: row.description,
      rationale: row.rationale,
      source: row.source as ImprovementProposal['source'],
      status: row.status as ImprovementStatus,
      priority: row.priority,
      evidenceRefs: JSON.parse(row.evidence_refs_json || '[]'),
      panelId: row.panel_id || null,
      approvedBy: row.approved_by || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }
}
