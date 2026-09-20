import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SpecialistPanelService } from './specialist-panel-service';

export type ImprovementStatus = 'proposed' | 'scheduled' | 'executing' | 'verified' | 'evaluating' | 'applied' | 'rejected' | 'no_change' | 'regressed' | 'needs_more_evidence';

export interface ImprovementProposal {
  id: string;
  type: 'bug_fix' | 'feature' | 'refactor' | 'performance' | 'security';
  title: string;
  description: string;
  rationale: string;
  source: 'reflection' | 'invention' | 'gap_analysis' | 'feedback' | 'refinement';
  status: ImprovementStatus;
  priority: number;
  evidenceRefs: string[];
  panelId: string | null;
  approvedBy: string | null;
  /** Set once a refinement child has been created from this proposal — bounds refinement to at most one attempt. */
  refinedAt: string | null;
  /** Set when this proposal IS a refinement of another — prevents refinement chains. */
  refinedFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImprovementRow {
  id: string; type: string; title: string; description: string; rationale: string;
  source: string; status: string; priority: number; evidence_refs_json?: string;
  panel_id?: string | null; approved_by?: string | null; created_at: string; updated_at?: string | null;
  refined_at?: string | null; refined_from_id?: string | null;
}

type ProposalInput = Pick<ImprovementProposal, 'type' | 'title' | 'description' | 'rationale' | 'source' | 'priority'> & {
  evidenceRefs?: string[];
  /** When set, links this new proposal to the parked proposal it refines and flags that parent as refined. */
  refinedFromId?: string;
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
  }, includeExisting = false): ImprovementProposal[] {
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
      }, includeExisting);
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

  /**
   * Routes security-scan findings through the same specialist-panel review
   * gate every other self-improvement proposal gets. Before this,
   * AutonomousGoalGenerator.generateFromSecurityFindings() created goals
   * directly at risk_class:'high', fully autonomous, with no review at all —
   * the one category most needing scrutiny skipped it entirely. Mirrors
   * generateFromBuildErrors() exactly; createProposal()'s existing
   * type==='security' handling already forces risk_class:'high' and
   * specialist_ids:['systems_architect','security_reviewer'] — no new
   * review logic needed.
   */
  generateFromSecurityFindings(findings: string[]): ImprovementProposal[] {
    return findings.slice(0, 5).flatMap((finding) => {
      const proposal = this.createProposal({
        type: 'security',
        title: `Security: ${finding.slice(0, 60)}`,
        description: finding,
        rationale: 'Security scan finding detected',
        source: 'feedback',
        priority: 0.95,
        evidenceRefs: ['security-scan'],
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
    return this.authorizeGoal(id, approvedBy);
  }

  /**
   * Autonomous counterpart to approveImprovement(): same consensus and
   * reviewer-separation requirements, but callable without a human operator
   * and without throwing when the panel simply isn't at consensus yet (that's
   * the normal, frequent case for a scheduler polling proposals — not an
   * error). `runId` scopes the approver identity so it's traceable to a
   * specific scheduler tick, and — same as the reviewer-separation check
   * below — is a distinct identity from every reviewer on this panel.
   *
   * Returns the updated proposal whenever this call changed its status
   * (authorized as a goal, or parked as needs_more_evidence), null when
   * there was nothing to do yet. Parking matters: without it a panel that
   * reaches consensus_ready on anything other than 'goal' left the proposal
   * at 'proposed' forever, silently re-checked every tick with no signal
   * that it was effectively dead — found in production on 2026-09-19, where
   * 104 reviewed proposals had sat unresolved for up to 6 days.
   */
  agentApproveIfReady(id: string, runId: string): ImprovementProposal | null {
    const proposal = this.getImprovement(id);
    if (proposal.status !== 'proposed' || !proposal.panelId) return null;
    const panel = this.panels.getPanel(proposal.panelId);
    if (panel.status !== 'consensus_ready') return null;
    if (panel.consensus.decision === 'goal') return this.authorizeGoal(id, `agent:approver:${runId}`);
    this.transition(id, 'needs_more_evidence');
    return this.getImprovement(id);
  }

  private authorizeGoal(id: string, approvedBy: string): ImprovementProposal {
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

  private createProposal(input: ProposalInput, includeExisting = false): ImprovementProposal | null {
    const fingerprint = createHash('sha256')
      .update(`${input.source}\0${input.title.trim().toLowerCase()}\0${input.description.trim().toLowerCase()}`)
      .digest('hex');
    const duplicate = this.db.prepare(
      "SELECT id FROM self_improvements WHERE fingerprint = ? AND status IN ('proposed', 'scheduled', 'executing', 'verified', 'evaluating') LIMIT 1"
    ).get(fingerprint) as { id: string } | undefined;
    if (duplicate) {
      if (!includeExisting) return null;
      return this.db.transaction(() => {
        const proposal = this.getImprovement(duplicate.id);
        const additions = (input.evidenceRefs || []).filter(ref => !proposal.evidenceRefs.includes(ref));
        if (!additions.length || !proposal.panelId) return proposal;
        const panel = this.panels.getPanel(proposal.panelId);
        const now = new Date().toISOString();
        if (proposal.status === 'proposed' && panel.status === 'planned' && !panel.reviews?.length) {
          const evidenceRefs = [...new Set([...proposal.evidenceRefs, ...additions])];
          this.db.prepare('UPDATE self_improvements SET evidence_refs_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(evidenceRefs), now, proposal.id);
          this.db.prepare('UPDATE specialist_panels SET context_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify({ ...panel.context, evidence_refs: evidenceRefs }), now, panel.id);
        } else {
          // Freeze the reviewed decision basis; later corroboration remains explicitly unreviewed.
          const pending = Array.isArray(panel.metadata.pending_evidence_refs) ? panel.metadata.pending_evidence_refs : [];
          this.db.prepare('UPDATE specialist_panels SET metadata = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify({ ...panel.metadata, pending_evidence_refs: [...new Set([...pending, ...additions])] }), now, panel.id);
        }
        return this.getImprovement(proposal.id);
      })();
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const evidenceRefs = Array.from(new Set(input.evidenceRefs || []));
    const riskClass = input.type === 'security' ? 'high' : 'low';
    const specialistIds = input.type === 'security'
      ? ['systems_architect', 'security_reviewer']
      : ['systems_architect', 'runtime_engineer'];
    const priority = this.adjustPriorityForHistory(input.source, input.priority);

    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO self_improvements (
          id, type, title, description, rationale, source, status, priority,
          fingerprint, evidence_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)
      `).run(id, input.type, input.title, input.description, input.rationale, input.source, priority, fingerprint, JSON.stringify(evidenceRefs), now, now);
      const panel = this.panels.createPanel({
        topic: input.title,
        question: `Should self-improvement proposal ${id} be authorized as a goal?`,
        risk_class: riskClass,
        specialist_ids: specialistIds,
        context: { proposal_id: id, description: input.description, rationale: input.rationale, evidence_refs: evidenceRefs },
        metadata: { self_improvement_id: id },
      });
      this.db.prepare('UPDATE self_improvements SET panel_id = ? WHERE id = ?').run(panel.id, id);
      if (input.refinedFromId) {
        this.db.prepare('UPDATE self_improvements SET refined_from_id = ? WHERE id = ?').run(input.refinedFromId, id);
        this.db.prepare('UPDATE self_improvements SET refined_at = ?, updated_at = ? WHERE id = ?').run(now, now, input.refinedFromId);
      }
    });
    create();
    return this.getImprovement(id);
  }

  /**
   * Turns a parked (needs_more_evidence) proposal's reviewer dissent into one
   * refined follow-up proposal, so specific, actionable feedback ("lacks
   * technical specifications for X") isn't just discarded — found on
   * 2026-09-19/20: 0 of 357 proposals ever reached 'goal', all from vague
   * reflections. Bounded to at most one refinement per original: guarded here
   * against a proposal that's already spawned one (refinedAt set) or that is
   * itself already a refinement (refinedFromId set) — no recursive chains.
   */
  refineFromDissent(parkedId: string, draft: { title: string; description: string; rationale: string }): ImprovementProposal | null {
    const parked = this.getImprovement(parkedId);
    if (parked.status !== 'needs_more_evidence') return null;
    if (parked.refinedAt || parked.refinedFromId) return null;
    return this.createProposal({
      type: parked.type,
      title: draft.title.slice(0, 80),
      description: draft.description,
      rationale: draft.rationale,
      source: 'refinement',
      priority: parked.priority,
      evidenceRefs: [...parked.evidenceRefs, `refinement-of:${parkedId}`],
      refinedFromId: parkedId,
    });
  }

  /** Parked proposals eligible for exactly one refinement attempt, oldest first. */
  getRefinementEligible(limit: number): ImprovementProposal[] {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    // With Commons review enabled, refine only proposals whose review finished (or timed out),
    // reviewed-first; otherwise behaviour is unchanged (oldest first).
    const gated = process.env.COMMONS_PROPOSAL_REVIEW_ENABLED === 'true';
    const rows = this.db.prepare(`
      SELECT s.* FROM self_improvements s
      LEFT JOIN commons_proposal_reviews r ON r.improvement_id = s.id
      WHERE s.status = 'needs_more_evidence' AND s.refined_at IS NULL AND s.refined_from_id IS NULL
        AND (? = 0 OR r.status IN ('completed', 'timeout'))
      ORDER BY (r.status = 'completed') DESC, s.created_at ASC LIMIT ?
    `).all(gated ? 1 : 0, normalizedLimit);
    return (rows as ImprovementRow[]).map((row) => this.rowToProposal(row));
  }

  /**
   * The first real outcome-feedback signal in this pipeline: found
   * 2026-09-21 that nothing reads past self_improvements/goals outcomes to
   * adjust future proposal generation — every past result was write-only.
   * Deliberately narrow: one signal (recent park rate for this source), one
   * bounded adjustment (priority only, never suppresses a proposal or
   * changes its content), applied uniformly across every source so a
   * struggling source (including 'refinement' itself) shows up rather than
   * being exempted from measurement.
   */
  private adjustPriorityForHistory(source: string, basePriority: number): number {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as n FROM (
        SELECT status FROM self_improvements WHERE source = ? AND status != 'proposed'
        ORDER BY created_at DESC LIMIT 20
      ) GROUP BY status
    `).all(source) as Array<{ status: string; n: number }>;
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    if (total < 5) return basePriority; // not enough resolved history to judge yet
    const parked = rows.find((row) => row.status === 'needs_more_evidence')?.n ?? 0;
    const parkRate = parked / total;
    return parkRate > 0.7 ? Math.max(0.1, basePriority - 0.1) : basePriority;
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
      refinedAt: row.refined_at || null,
      refinedFromId: row.refined_from_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }
}
