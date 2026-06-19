import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type WorkItemRecord } from './work-item-service';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type PanelStatus = 'planned' | 'reviewing' | 'consensus_ready' | 'backlog_created' | 'goal_created' | 'cancelled';
type ReviewStance = 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
type ReviewStatus = 'draft' | 'submitted' | 'rejected';
type ConsensusLevel = 'strong' | 'weak' | 'blocked' | 'no_consensus';
type ConsensusDecision = 'goal' | 'backlog' | 'needs_more_evidence' | 'blocked';

export interface SpecialistProfile {
  id: string;
  version?: string;
  title: string;
  domains: string[];
  default_questions: string[];
  required_evidence: string[];
  forbidden_claims: string[];
  output_schema: string[];
}

export interface SpecialistPanelRecord {
  id: string;
  topic: string;
  question: string;
  status: PanelStatus;
  risk_class: RiskClass;
  panel: SpecialistProfile[];
  context: Record<string, unknown>;
  consensus: SpecialistConsensus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reviews?: SpecialistReviewRecord[];
}

export interface SpecialistReviewRecord {
  id: string;
  panel_id: string;
  specialist_id: string;
  specialist_title: string;
  stance: ReviewStance;
  confidence: number;
  findings: string[];
  recommendations: string[];
  evidence_refs: string[];
  limitations: string | null;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface SpecialistConsensus {
  required_reviews: number;
  submitted_reviews: number;
  support_count: number;
  oppose_count: number;
  uncertain_count: number;
  needs_evidence_count: number;
  average_confidence: number;
  consensus_level: ConsensusLevel;
  decision: ConsensusDecision;
  dissent: Array<Pick<SpecialistReviewRecord, 'specialist_id' | 'specialist_title' | 'stance' | 'limitations'>>;
  next_actions: string[];
}

export interface SpecialistPanelCreateInput {
  topic: string;
  question: string;
  risk_class?: RiskClass;
  specialist_ids?: string[];
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SpecialistReviewInput {
  specialist_id: string;
  stance: ReviewStance;
  confidence: number;
  findings?: string[];
  recommendations?: string[];
  evidence_refs?: string[];
  limitations?: string;
}

const VALID_RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const VALID_STANCES: ReviewStance[] = ['support', 'oppose', 'uncertain', 'needs_evidence'];

const SPECIALIST_CATALOG: SpecialistProfile[] = [
  {
    id: 'systems_architect',
    title: 'Systems Architect',
    domains: ['distributed systems', 'control planes', 'operability'],
    default_questions: ['Is the design bounded, observable and reversible?', 'Which interfaces are stable enough to automate?'],
    required_evidence: ['architecture boundary', 'state transition', 'failure mode'],
    forbidden_claims: ['Claims of scalability without resource or queue evidence.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'security_reviewer',
    title: 'Security Reviewer',
    domains: ['threat modeling', 'secrets', 'auth', 'policy'],
    default_questions: ['Does this expand autonomy or secret access?', 'What approval gate is mandatory?'],
    required_evidence: ['trust boundary', 'sensitive action list', 'approval requirement'],
    forbidden_claims: ['Security approval based only on another LLM review.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'runtime_engineer',
    title: 'Runtime Engineer',
    domains: ['Codex', 'OpenCode', 'process supervision', 'worktrees'],
    default_questions: ['Can the runtime report real usage and artifacts?', 'How are leases stopped or retried?'],
    required_evidence: ['runtime command contract', 'artifact path', 'budget signal'],
    forbidden_claims: ['Active execution inferred from registry rows only.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'memory_scientist',
    title: 'Memory Scientist',
    domains: ['retrieval', 'OKF', 'Qdrant', 'knowledge lifecycle'],
    default_questions: ['What deserves durable memory?', 'What must remain candidate-only?'],
    required_evidence: ['source reference', 'promotion gate', 'retrieval test'],
    forbidden_claims: ['Policy learning without human approval.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'skill_evaluator',
    title: 'Skill Evaluator',
    domains: ['skill quality', 'evaluation', 'agent instructions'],
    default_questions: ['Is this a reusable skill or one-off procedure?', 'How is the skill validated before orchestration?'],
    required_evidence: ['trigger rule', 'allowed actions', 'evaluation scenario'],
    forbidden_claims: ['Draft skills can orchestrate live workers.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'math_logician',
    title: 'Mathematical Logician',
    domains: ['formal reasoning', 'invariants', 'proof obligations'],
    default_questions: ['Which invariant must never be violated?', 'Can the decision be falsified deterministically?'],
    required_evidence: ['invariant', 'counterexample check', 'acceptance criterion'],
    forbidden_claims: ['Consensus treated as proof.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'behavioral_scientist',
    title: 'Behavioral Scientist',
    domains: ['human factors', 'workflow design', 'operator trust'],
    default_questions: ['Does the system create comprehension debt?', 'Where does the operator need a clear intervention point?'],
    required_evidence: ['operator action', 'feedback loop', 'failure visibility'],
    forbidden_claims: ['Autonomy improvements without operator load analysis.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'philosopher_ethicist',
    title: 'Philosopher Ethicist',
    domains: ['epistemology', 'accountability', 'governance'],
    default_questions: ['What is the system allowed to know, infer and act on?', 'Who remains accountable after automation?'],
    required_evidence: ['accountability boundary', 'uncertainty statement', 'human gate'],
    forbidden_claims: ['Self-awareness or truth claims beyond observable state.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'domain_biologist',
    title: 'Domain Biologist',
    domains: ['biological systems', 'adaptation', 'feedback'],
    default_questions: ['Is the feedback loop resilient or brittle?', 'Where can runaway adaptation occur?'],
    required_evidence: ['feedback signal', 'selection pressure', 'containment mechanism'],
    forbidden_claims: ['Biological metaphor presented as validation evidence.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'domain_physicist',
    title: 'Domain Physicist',
    domains: ['systems dynamics', 'resource limits', 'measurement'],
    default_questions: ['Which quantities are measured instead of inferred?', 'What budget or conservation rule bounds the process?'],
    required_evidence: ['measurement', 'budget', 'load or capacity signal'],
    forbidden_claims: ['Unlimited scaling claims.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'mathematician',
    version: '1.0.0',
    title: 'Mathematician',
    domains: ['mathematics', 'optimization', 'invariants', 'formal models'],
    default_questions: ['Which invariant bounds this system?', 'Which scoring or optimization rule is falsifiable?'],
    required_evidence: ['formal invariant', 'counterexample check', 'measurable score'],
    forbidden_claims: ['A consensus verdict presented as mathematical proof.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'physicist',
    version: '1.0.0',
    title: 'Physicist',
    domains: ['systems dynamics', 'resource limits', 'measurement', 'stability'],
    default_questions: ['Which resource quantity bounds execution?', 'Which feedback loop is unstable under load?'],
    required_evidence: ['measurement', 'budget', 'load or capacity signal'],
    forbidden_claims: ['Unlimited scaling claims.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'biologist',
    version: '1.0.0',
    title: 'Biologist',
    domains: ['adaptation', 'resilience', 'feedback ecology', 'selection pressure'],
    default_questions: ['Which adaptation loop could run away?', 'Where is resilience measured rather than assumed?'],
    required_evidence: ['feedback signal', 'selection pressure', 'containment mechanism'],
    forbidden_claims: ['Biological metaphor presented as validation evidence.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'psychologist',
    version: '1.0.0',
    title: 'Psychologist',
    domains: ['cognitive load', 'operator trust', 'decision fatigue', 'attention'],
    default_questions: ['Where can the operator misunderstand agent state?', 'Which intervention point prevents over-trust?'],
    required_evidence: ['operator-facing state', 'decision pressure', 'feedback timing'],
    forbidden_claims: ['Trust improvement without operator-facing evidence.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'philosopher',
    version: '1.0.0',
    title: 'Philosopher',
    domains: ['epistemology', 'definitions', 'ethics', 'accountability'],
    default_questions: ['What would count as knowing here?', 'Which claim is underdefined or ethically loaded?'],
    required_evidence: ['definition boundary', 'uncertainty statement', 'accountability owner'],
    forbidden_claims: ['Self-awareness or truth claims beyond observable state.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'product_strategist',
    version: '1.0.0',
    title: 'Product Strategist',
    domains: ['value scoring', 'backlog shaping', 'operator workflow', 'adoption'],
    default_questions: ['Which work item has the highest validated leverage?', 'What should be deferred despite being interesting?'],
    required_evidence: ['value score', 'user impact', 'risk tradeoff'],
    forbidden_claims: ['Priority claims without value and risk evidence.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
  {
    id: 'data_scientist',
    version: '1.0.0',
    title: 'Data Scientist',
    domains: ['metrics', 'experiments', 'statistical validity', 'evaluation'],
    default_questions: ['Which metric proves improvement?', 'Is the sample sufficient to trust the conclusion?'],
    required_evidence: ['metric definition', 'baseline', 'sample or fixture'],
    forbidden_claims: ['Performance improvement without baseline comparison.'],
    output_schema: ['stance', 'confidence', 'findings', 'recommendations', 'evidence_refs', 'limitations'],
  },
];

const DEFAULT_SPECIALISTS = [
  'systems_architect',
  'security_reviewer',
  'runtime_engineer',
  'memory_scientist',
  'skill_evaluator',
  'philosopher_ethicist',
];

export class SpecialistPanelService {
  private workItems: WorkItemService;

  constructor(private db: Database) {
    this.workItems = new WorkItemService(db);
  }

  getCatalog(): SpecialistProfile[] {
    return SPECIALIST_CATALOG;
  }

  listPanels(limit = 100): SpecialistPanelRecord[] {
    const normalizedLimit = Math.max(1, Math.min(Number(limit || 100), 500));
    return (this.db.prepare('SELECT * FROM specialist_panels ORDER BY created_at DESC LIMIT ?').all(normalizedLimit) as any[])
      .map((row) => this.parsePanel(row));
  }

  getPanel(id: string): SpecialistPanelRecord {
    const row = this.db.prepare('SELECT * FROM specialist_panels WHERE id = ?').get(id);
    if (!row) {
      throw new Error('SPECIALIST_PANEL_NOT_FOUND');
    }
    const panel = this.parsePanel(row);
    panel.reviews = this.listReviews(id);
    return panel;
  }

  createPanel(input: SpecialistPanelCreateInput): SpecialistPanelRecord {
    if (!input.topic?.trim()) {
      throw new Error('SPECIALIST_PANEL_TOPIC_REQUIRED');
    }
    if (!input.question?.trim()) {
      throw new Error('SPECIALIST_PANEL_QUESTION_REQUIRED');
    }
    const riskClass = input.risk_class || 'medium';
    if (!VALID_RISKS.includes(riskClass)) {
      throw new Error('SPECIALIST_PANEL_RISK_INVALID');
    }
    const profiles = this.selectProfiles(input.specialist_ids || DEFAULT_SPECIALISTS, riskClass);
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO specialist_panels (
        id, topic, question, status, risk_class, panel_json, context_json,
        consensus_json, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.topic.trim(),
      input.question.trim(),
      'planned',
      riskClass,
      JSON.stringify(profiles),
      JSON.stringify(input.context || {}),
      JSON.stringify(this.emptyConsensus(profiles.length)),
      JSON.stringify({
        ...(input.metadata || {}),
        auto_propose_only: true,
        leases_created: 0,
        high_risk_requires_security_reviewer: ['high', 'critical'].includes(riskClass),
      }),
      now,
      now
    );

    return this.getPanel(id);
  }

  submitReview(panelId: string, input: SpecialistReviewInput): SpecialistPanelRecord {
    const panel = this.getPanel(panelId);
    if (panel.status === 'cancelled' || panel.status === 'backlog_created' || panel.status === 'goal_created') {
      throw new Error('SPECIALIST_PANEL_CLOSED');
    }
    if (!input.specialist_id?.trim()) {
      throw new Error('SPECIALIST_REVIEW_SPECIALIST_REQUIRED');
    }
    if (!VALID_STANCES.includes(input.stance)) {
      throw new Error('SPECIALIST_REVIEW_STANCE_INVALID');
    }
    const confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('SPECIALIST_REVIEW_CONFIDENCE_INVALID');
    }
    const profile = panel.panel.find((candidate) => candidate.id === input.specialist_id);
    if (!profile) {
      throw new Error('SPECIALIST_REVIEWER_NOT_IN_PANEL');
    }

    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM specialist_reviews WHERE panel_id = ? AND specialist_id = ?').get(panel.id, profile.id) as any;
    const id = existing?.id || randomUUID();
    const run = existing
      ? this.db.prepare(`
          UPDATE specialist_reviews
          SET specialist_title = ?, stance = ?, confidence = ?, findings_json = ?,
              recommendations_json = ?, evidence_refs_json = ?, limitations = ?,
              status = ?, updated_at = ?
          WHERE id = ?
        `)
      : this.db.prepare(`
          INSERT INTO specialist_reviews (
            specialist_title, stance, confidence, findings_json, recommendations_json,
            evidence_refs_json, limitations, status, updated_at, id, panel_id, specialist_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    const args = [
      profile.title,
      input.stance,
      confidence,
      JSON.stringify(this.stringArray(input.findings)),
      JSON.stringify(this.stringArray(input.recommendations)),
      JSON.stringify(this.stringArray(input.evidence_refs)),
      input.limitations?.trim() || null,
      'submitted',
      now,
      id,
    ];
    if (existing) {
      run.run(...args);
    } else {
      run.run(...args, panel.id, profile.id, now);
    }

    const reviews = this.listReviews(panel.id);
    const consensus = this.computeConsensus(panel, reviews);
    const nextStatus: PanelStatus = reviews.length >= panel.panel.length ? 'consensus_ready' : 'reviewing';
    this.db.prepare(`
      UPDATE specialist_panels
      SET status = ?, consensus_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      JSON.stringify(consensus),
      now,
      nextStatus === 'consensus_ready' ? now : null,
      panel.id
    );

    return this.getPanel(panel.id);
  }

  projectPanelToBacklog(panelId: string): { panel: SpecialistPanelRecord; work_item: WorkItemRecord; created: boolean } {
    const panel = this.getPanel(panelId);
    if (panel.status !== 'consensus_ready' && panel.status !== 'backlog_created') {
      throw new Error('SPECIALIST_PANEL_CONSENSUS_REQUIRED');
    }
    if (panel.consensus.decision === 'blocked') {
      throw new Error('SPECIALIST_PANEL_BLOCKED');
    }

    const nextActions = panel.consensus.next_actions.length
      ? panel.consensus.next_actions
      : ['Collect missing evidence before assigning work.'];
    const result = this.workItems.createIfMissingBySourceRef({
      title: `Specialist panel: ${panel.topic}`,
      description: [
        panel.question,
        '',
        `Consensus: ${panel.consensus.consensus_level}; decision: ${panel.consensus.decision}.`,
        `Next actions: ${nextActions.join(' ')}`,
      ].join('\n'),
      source: 'specialist_panel',
      source_ref: panel.id,
      risk_class: panel.risk_class,
      value_score: this.valueScoreFor(panel),
      confidence: panel.consensus.average_confidence || 0.5,
      status: panel.consensus.decision === 'needs_more_evidence' ? 'candidate' : 'triaged',
      recommended_loop: this.recommendedLoopFor(panel),
      metadata: {
        panel_id: panel.id,
        topic: panel.topic,
        decision: panel.consensus.decision,
        consensus_level: panel.consensus.consensus_level,
        dissent: panel.consensus.dissent,
        required_reviews: panel.consensus.required_reviews,
        submitted_reviews: panel.consensus.submitted_reviews,
      },
    });

    this.db.prepare(`
      UPDATE specialist_panels
      SET status = 'backlog_created', metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ ...panel.metadata, projected_work_item_id: result.work_item.id, leases_created: 0 }),
      new Date().toISOString(),
      panel.id
    );

    return { panel: this.getPanel(panel.id), work_item: result.work_item, created: result.created };
  }

  private selectProfiles(ids: string[], riskClass: RiskClass): SpecialistProfile[] {
    const uniqueIds = Array.from(new Set(ids));
    if (['high', 'critical'].includes(riskClass) && !uniqueIds.includes('security_reviewer')) {
      throw new Error('SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED');
    }
    const profiles = uniqueIds.map((id) => {
      const profile = SPECIALIST_CATALOG.find((candidate) => candidate.id === id);
      if (!profile) {
        throw new Error('SPECIALIST_PROFILE_UNKNOWN');
      }
      return profile;
    });
    if (profiles.length < 2) {
      throw new Error('SPECIALIST_PANEL_TOO_SMALL');
    }
    return profiles;
  }

  private computeConsensus(panel: SpecialistPanelRecord, reviews: SpecialistReviewRecord[]): SpecialistConsensus {
    const required = panel.panel.length;
    const submitted = reviews.filter((review) => review.status === 'submitted');
    const supportCount = submitted.filter((review) => review.stance === 'support').length;
    const opposeCount = submitted.filter((review) => review.stance === 'oppose').length;
    const uncertainCount = submitted.filter((review) => review.stance === 'uncertain').length;
    const needsEvidenceCount = submitted.filter((review) => review.stance === 'needs_evidence').length;
    const averageConfidence = submitted.length
      ? Number((submitted.reduce((sum, review) => sum + review.confidence, 0) / submitted.length).toFixed(3))
      : 0;
    const dissent = submitted
      .filter((review) => review.stance === 'oppose' || review.stance === 'needs_evidence')
      .map((review) => ({
        specialist_id: review.specialist_id,
        specialist_title: review.specialist_title,
        stance: review.stance,
        limitations: review.limitations,
      }));

    let consensusLevel: ConsensusLevel = 'no_consensus';
    let decision: ConsensusDecision = 'needs_more_evidence';
    if (submitted.length < required) {
      consensusLevel = 'no_consensus';
      decision = 'needs_more_evidence';
    } else if (opposeCount > 0) {
      consensusLevel = 'blocked';
      decision = 'blocked';
    } else if (needsEvidenceCount > 0 || uncertainCount >= Math.ceil(required / 2)) {
      consensusLevel = 'weak';
      decision = 'needs_more_evidence';
    } else if (supportCount === required && averageConfidence >= 0.8) {
      consensusLevel = 'strong';
      decision = panel.risk_class === 'low' ? 'goal' : 'backlog';
    } else if (supportCount >= Math.ceil(required * 0.66)) {
      consensusLevel = 'weak';
      decision = 'backlog';
    }

    return {
      required_reviews: required,
      submitted_reviews: submitted.length,
      support_count: supportCount,
      oppose_count: opposeCount,
      uncertain_count: uncertainCount,
      needs_evidence_count: needsEvidenceCount,
      average_confidence: averageConfidence,
      consensus_level: consensusLevel,
      decision,
      dissent,
      next_actions: this.nextActionsFor(decision, submitted),
    };
  }

  private nextActionsFor(decision: ConsensusDecision, reviews: SpecialistReviewRecord[]): string[] {
    const recommendations = reviews.flatMap((review) => review.recommendations).filter(Boolean);
    if (decision === 'blocked') {
      return ['Do not spawn workers. Resolve dissent and missing evidence first.', ...recommendations].slice(0, 8);
    }
    if (decision === 'needs_more_evidence') {
      return ['Collect deterministic evidence before creating worker leases.', ...recommendations].slice(0, 8);
    }
    return ['Project to backlog before worker leasing; keep maker/checker separation.', ...recommendations].slice(0, 8);
  }

  private recommendedLoopFor(panel: SpecialistPanelRecord): string {
    const topic = `${panel.topic} ${panel.question}`.toLowerCase();
    if (panel.risk_class === 'high' || panel.risk_class === 'critical' || /(security|auth|secret|policy|token|infra)/.test(topic)) {
      return 'security-regression-loop';
    }
    if (/(skill|agent|prompt|instruction)/.test(topic)) {
      return 'skill-quality-loop';
    }
    if (/(memory|okf|qdrant|knowledge|uams)/.test(topic)) {
      return 'okf-synchronization-loop';
    }
    if (/(mcp|connector|api)/.test(topic)) {
      return 'mcp-connector-validation-loop';
    }
    return 'repo-maintenance-loop';
  }

  private valueScoreFor(panel: SpecialistPanelRecord): number {
    const confidenceScore = Math.round((panel.consensus.average_confidence || 0.5) * 30);
    const riskScore = panel.risk_class === 'critical' ? 30 : panel.risk_class === 'high' ? 25 : panel.risk_class === 'medium' ? 18 : 10;
    const supportScore = panel.consensus.support_count * 8;
    return Math.min(100, 35 + confidenceScore + riskScore + supportScore);
  }

  private listReviews(panelId: string): SpecialistReviewRecord[] {
    return (this.db.prepare('SELECT * FROM specialist_reviews WHERE panel_id = ? ORDER BY created_at ASC').all(panelId) as any[])
      .map((row) => this.parseReview(row));
  }

  private emptyConsensus(requiredReviews: number): SpecialistConsensus {
    return {
      required_reviews: requiredReviews,
      submitted_reviews: 0,
      support_count: 0,
      oppose_count: 0,
      uncertain_count: 0,
      needs_evidence_count: 0,
      average_confidence: 0,
      consensus_level: 'no_consensus',
      decision: 'needs_more_evidence',
      dissent: [],
      next_actions: ['Collect independent specialist reviews.'],
    };
  }

  private parsePanel(row: any): SpecialistPanelRecord {
    return {
      id: row.id,
      topic: row.topic,
      question: row.question,
      status: row.status,
      risk_class: row.risk_class,
      panel: JSON.parse(row.panel_json || '[]'),
      context: JSON.parse(row.context_json || '{}'),
      consensus: JSON.parse(row.consensus_json || '{}'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null,
    };
  }

  private parseReview(row: any): SpecialistReviewRecord {
    return {
      id: row.id,
      panel_id: row.panel_id,
      specialist_id: row.specialist_id,
      specialist_title: row.specialist_title,
      stance: row.stance,
      confidence: row.confidence,
      findings: JSON.parse(row.findings_json || '[]'),
      recommendations: JSON.parse(row.recommendations_json || '[]'),
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      limitations: row.limitations || null,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private stringArray(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input.map((item) => String(item).trim()).filter(Boolean);
  }
}
