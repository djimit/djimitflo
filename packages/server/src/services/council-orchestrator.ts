import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import { CouncilRegistry, type CouncilSelection, type CouncilModelRecord } from './council-registry';
import { TaskRouter, type TaskClassification } from './task-router';
import { StructuredEvaluator, type EvaluationScores, type AggregatedScore } from './structured-evaluator';
import { SynthesisEngine } from './synthesis-engine';
import { MultiModelIntelligence } from './multi-model-intelligence';
// reasoning-loop available for future per-phase reasoning depth

export type CouncilMode = 'fast' | 'review' | 'council';
export type CouncilPhase = 'diverge' | 'review' | 'synthesize' | 'completed' | 'failed' | 'escalated' | 'diverging' | 'reviewing' | 'synthesizing';

export interface CouncilSession {
  id: string;
  task_id: string | null;
  mode: CouncilMode;
  status: CouncilPhase;
  task_description: string;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  model_count: number;
  max_reasoning_depth: number;
  convergence_threshold: number;
  synthesis_model: string | null;
  final_output: string | null;
  final_confidence: number | null;
  token_usage: number;
  cost_dollars: number;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CouncilOutputRecord {
  id: string;
  session_id: string;
  model: string;
  phase: string;
  anonymous_id: string;
  content: string;
  structured_score: string | null;
  ranking_position: number | null;
  token_count: number;
  latency_ms: number;
  created_at: string;
}

export interface CouncilCreateInput {
  task_description: string;
  task_id?: string;
  mode?: CouncilMode;
  risk_class?: 'low' | 'medium' | 'high' | 'critical';
  privacy_sensitive?: boolean;
  realtime?: boolean;
  max_cost?: number;
  custom_models?: string[];
  independent_judge?: boolean;
  judge_model?: string;
}

export interface CouncilResult {
  session: CouncilSession;
  outputs: CouncilOutputRecord[];
  evaluations: AggregatedScore[];
  synthesis: string | null;
  confidence: number;
  cost_dollars: number;
  duration_ms: number;
  requires_human_approval: boolean;
}

const ANONYMOUS_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export class CouncilOrchestrator {
  private registry: CouncilRegistry;
  private router: TaskRouter;
  private evaluator: StructuredEvaluator;
  private synthesizer: SynthesisEngine;
  private modelRouter: MultiModelIntelligence;
  constructor(private db: Database) {
    this.registry = new CouncilRegistry(db);
    this.router = new TaskRouter();
    this.evaluator = new StructuredEvaluator(db);
    this.synthesizer = new SynthesisEngine(db);
    this.modelRouter = new MultiModelIntelligence(db);
  }

  async createSession(input: CouncilCreateInput): Promise<CouncilSession> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const classification: TaskClassification = input.mode
      ? {
          mode: input.mode,
          risk_class: input.risk_class ?? 'low',
          model_count: input.mode === 'fast' ? 1 : input.mode === 'review' ? 2 : 3,
          reasoning_depth: input.mode === 'fast' ? 1 : input.mode === 'review' ? 2 : 3,
          requires_human_approval: (input.risk_class ?? 'low') === 'critical',
          privacy_required: input.privacy_sensitive ? 'local' : 'public_api',
          estimated_cost: 0,
          estimated_latency_ms: 0,
          reasoning: ['Manual mode selected'],
        }
      : this.router.classify({
          description: input.task_description,
          risk_class: input.risk_class,
          privacy_sensitive: input.privacy_sensitive,
          realtime: input.realtime,
        });

    this.db.prepare(`
      INSERT INTO council_sessions (
        id, task_id, mode, status, task_description, risk_class,
        model_count, max_reasoning_depth, convergence_threshold,
        token_usage, cost_dollars, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.task_id ?? null,
      classification.mode,
      'diverging',
      input.task_description,
      classification.risk_class,
      classification.model_count,
      classification.reasoning_depth,
      0.75,
      0,
      0,
      JSON.stringify({
        classification,
        reasoning_classification: classification.reasoning,
        max_cost: input.max_cost,
        custom_models: input.custom_models,
        independent_judge: input.independent_judge === true,
        judge_model: input.judge_model,
      }),
      now,
      now,
    );

    const session = this.getSession(id);

    swarmEventBus.emit('council:session:started', {
      session_id: id,
      mode: classification.mode,
      risk_class: classification.risk_class,
      model_count: classification.model_count,
    });

    return session;
  }

  getSession(id: string): CouncilSession {
    const row = this.db.prepare('SELECT * FROM council_sessions WHERE id = ?').get(id) as any;
    if (!row) throw new Error('COUNCIL_SESSION_NOT_FOUND');
    return this.parseSession(row);
  }

  listSessions(limit = 50): CouncilSession[] {
    const rows = this.db.prepare(
      'SELECT * FROM council_sessions ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => this.parseSession(r));
  }

  getSessionOutputs(sessionId: string): CouncilOutputRecord[] {
    this.getSession(sessionId);
    const rows = this.db.prepare(
      'SELECT * FROM council_outputs WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as any[];
    return rows.map(r => this.parseOutput(r));
  }

  getSessionStatus(sessionId: string): {
    session: CouncilSession;
    phase: CouncilPhase;
    outputs_count: number;
    evaluations_count: number;
    aggregated: AggregatedScore[];
    disagreement: number;
  } {
    const session = this.getSession(sessionId);
    const outputs = this.getSessionOutputs(sessionId);
    const aggregated = this.evaluator.aggregateScores(sessionId);
    const disagreement = this.evaluator.calculateDisagreement(sessionId);

    const evaluationsCount = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM council_evaluations WHERE session_id = ?'
    ).get(sessionId) as { cnt: number };

    return {
      session,
      phase: session.status as CouncilPhase,
      outputs_count: outputs.length,
      evaluations_count: evaluationsCount.cnt,
      aggregated,
      disagreement,
    };
  }

  async executeCouncil(sessionId: string): Promise<CouncilResult> {
    const startTime = Date.now();
    const session = this.getSession(sessionId);
    if (session.status !== 'diverging') {
      throw new Error('COUNCIL_SESSION_NOT_EXECUTABLE');
    }

    try {
      let selection = this.registry.selectModelsForCouncil({
        mode: session.mode as CouncilMode,
        risk_class: session.risk_class as any,
        privacy_required: (session.metadata.classification as TaskClassification | undefined)?.privacy_required,
        max_cost: session.metadata.max_cost as number | undefined,
        custom_models: session.metadata.custom_models as string[] | undefined,
      });
      selection = this.routeCouncilSelection(selection);
      const judge = this.selectIndependentJudge(session, selection);

      swarmEventBus.emit('council:diverge:started', {
        session_id: sessionId,
        models: selection.models.map(m => m.model_name),
      });

      const divergeOutputs = await this.executeDivergePhase(sessionId, session.task_description, selection);
      this.updateSessionPhase(sessionId, 'reviewing');

      swarmEventBus.emit('council:review:started', { session_id: sessionId });

      await this.executeReviewPhase(sessionId, session.task_description, selection, divergeOutputs, judge);
      this.updateSessionPhase(sessionId, 'synthesizing');

      swarmEventBus.emit('council:synthesize:started', { session_id: sessionId });

      const synthesis = this.executeSynthesizePhase(sessionId);

      const duration = Date.now() - startTime;
      this.finalizeSession(sessionId, synthesis.output, synthesis.confidence, duration);

      const finalSession = this.getSession(sessionId);
      const outputs = this.getSessionOutputs(sessionId);
      const aggregated = this.evaluator.aggregateScores(sessionId);

      swarmEventBus.emit('council:session:completed', {
        session_id: sessionId,
        mode: session.mode,
        confidence: synthesis.confidence,
        duration_ms: duration,
      });

      return {
        session: finalSession,
        outputs,
        evaluations: aggregated,
        synthesis: synthesis.output,
        confidence: synthesis.confidence,
        cost_dollars: finalSession.cost_dollars,
        duration_ms: duration,
        requires_human_approval: session.risk_class === 'critical'
          || (session.risk_class === 'high' && session.mode === 'council'),
      };
    } catch (error) {
      this.updateSessionPhase(sessionId, 'failed');
      swarmEventBus.emit('council:session:failed', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Call a council model. Ollama models go direct; everything else goes
   * through the LiteLLM proxy (OpenAI-compatible), which fronts
   * OpenAI/Anthropic/Google/OpenRouter with one code path.
   */
  private async callModel(
    model: CouncilModelRecord,
    prompt: string,
  ): Promise<{ content: string; tokens: number; latencyMs: number }> {
    const start = Date.now();

    if (model.provider === 'ollama') {
      const base = process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.model_name,
          prompt,
          stream: false,
          think: false,
          options: { num_predict: Math.max(32, Math.min(Number(process.env.COUNCIL_OLLAMA_MAX_TOKENS || 128), 2048)) },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Ollama ${model.model_name}: HTTP ${response.status}`);
      const data = await response.json() as { response: string; eval_count?: number };
      return {
        content: data.response,
        tokens: data.eval_count ?? Math.ceil(data.response.length / 4),
        latencyMs: Date.now() - start,
      };
    }

    const base = process.env.LITELLM_URL || 'http://192.168.1.28:4000';
    const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_OPENCODE_KEY || '';
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.model_name,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`LiteLLM ${model.model_name}: HTTP ${response.status}`);
    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      tokens: data.usage?.total_tokens ?? Math.ceil(content.length / 4),
      latencyMs: Date.now() - start,
    };
  }

  private async executeDivergePhase(
    sessionId: string,
    taskDescription: string,
    selection: CouncilSelection,
  ): Promise<CouncilOutputRecord[]> {
    const prompt = `You are one member of an anonymous model council. Independently produce your best answer to the task below. Be concrete and complete; do not mention that you are part of a council.\n\nTask:\n${taskDescription}`;

    const outputs = await Promise.all(selection.models.map(async (model, i) => {
      const anonId = ANONYMOUS_IDS[i];
      const id = randomUUID();
      const now = new Date().toISOString();

      let result: { content: string; tokens: number; latencyMs: number };
      try {
        result = await this.callModel(model, prompt);
        this.modelRouter.recordOutcome({
          modelId: `council:${model.id}`,
          taskType: 'council-diverge',
          success: true,
          score: model.avg_governance_score,
          latencyMs: result.latencyMs,
        });
      } catch (error) {
        this.modelRouter.recordOutcome({ modelId: `council:${model.id}`, taskType: 'council-diverge', success: false });
        throw error;
      }

      this.db.prepare(`
        INSERT INTO council_outputs (id, session_id, model, phase, anonymous_id, content, token_count, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, model.model_name, 'diverge', anonId, result.content, result.tokens, result.latencyMs, now);

      this.registry.updateModelStats(model.id, result.tokens, result.latencyMs);

      return {
        id,
        session_id: sessionId,
        model: model.model_name,
        phase: 'diverge',
        anonymous_id: anonId,
        content: result.content,
        structured_score: null,
        ranking_position: null,
        token_count: result.tokens,
        latency_ms: result.latencyMs,
        created_at: now,
      } satisfies CouncilOutputRecord;
    }));

    swarmEventBus.emit('council:diverge:completed', {
      session_id: sessionId,
      output_count: outputs.length,
    });

    return outputs;
  }

  private async executeReviewPhase(
    sessionId: string,
    taskDescription: string,
    selection: CouncilSelection,
    divergeOutputs: CouncilOutputRecord[],
    judge?: CouncilModelRecord,
  ): Promise<void> {
    const evaluators = judge ? [judge] : selection.models;
    await Promise.all(evaluators.map(async (evaluatorModel) => {
      const candidates = judge ? divergeOutputs : divergeOutputs.filter(o => o.model !== evaluatorModel.model_name);
      if (candidates.length === 0) return;

      const prompt = [
        'You are an impartial reviewer on an anonymous model council. Score each candidate answer to the task on a 1-5 scale per dimension.',
        `Task:\n${taskDescription}`,
        ...candidates.map(c => `Candidate ${c.anonymous_id}:\n${c.content}`),
        'Respond with ONLY a JSON object, no prose, in this exact shape:',
        `{"evaluations":[{"candidate":"A","correctness":4,"evidence_quality":3,"completeness":4,"risk_score":4,"policy_compliance":5,"reasoning":"one sentence"}],"ranking":["A","B"],"confidence":0.8}`,
      ].join('\n\n');

      const result = await this.callModel(evaluatorModel, prompt);
      const parsed = this.parseReviewJson(result.content, candidates.map(c => c.anonymous_id));
      if (!parsed) throw new Error(`COUNCIL_REVIEW_INVALID:${evaluatorModel.model_name}`);
      const ranking = parsed.ranking!;

      for (const candidate of candidates) {
        const evaluation = parsed?.evaluations?.find(e => e.candidate === candidate.anonymous_id);
        const scores: EvaluationScores = {
          correctness: evaluation!.correctness!,
          evidence_quality: evaluation!.evidence_quality!,
          completeness: evaluation!.completeness!,
          risk_score: evaluation!.risk_score!,
          policy_compliance: evaluation!.policy_compliance!,
        };

        this.evaluator.storeEvaluation({
          session_id: sessionId,
          evaluator_model: evaluatorModel.model_name,
          candidate_id: candidate.anonymous_id,
          scores,
          ranking,
          confidence: parsed.confidence!,
          reasoning: evaluation!.reasoning!,
        });
      }
    }));

    swarmEventBus.emit('council:review:completed', {
      session_id: sessionId,
      evaluator_count: evaluators.length,
    });
  }

  private routeCouncilSelection(selection: CouncilSelection): CouncilSelection {
    for (const model of selection.models) {
      const modelId = `council:${model.id}`;
      if (!this.modelRouter.hasModel(modelId)) {
        this.modelRouter.registerModel({
          modelId,
          modelName: model.model_name,
          provider: model.provider,
          costPerMtok: model.cost_per_1m_tokens,
          capabilities: [{ taskType: 'council-diverge', successRate: 0.5 }],
        });
      }
    }
    const routed = this.modelRouter.routeWithCascade({ taskType: 'council-diverge' });
    const preferred = selection.models.find(model => `council:${model.id}` === routed.selectedModel);
    return preferred
      ? { ...selection, models: [preferred, ...selection.models.filter(model => model.id !== preferred.id)] }
      : selection;
  }

  private selectIndependentJudge(session: CouncilSession, selection: CouncilSelection): CouncilModelRecord | undefined {
    if (session.metadata.independent_judge !== true) return undefined;
    const candidates = this.registry.listModels('active')
      .filter(model => !selection.models.some(selected => selected.id === model.id))
      .filter(model => !session.metadata.judge_model || model.model_name === session.metadata.judge_model)
      .sort((a, b) => b.independence_score - a.independence_score || b.avg_governance_score - a.avg_governance_score);
    if (!candidates[0]) throw new Error('COUNCIL_NO_INDEPENDENT_JUDGE');
    return candidates[0];
  }

  private parseReviewJson(content: string, candidateIds: string[]): {
    evaluations?: Array<{
      candidate: string;
      correctness?: number;
      evidence_quality?: number;
      completeness?: number;
      risk_score?: number;
      policy_compliance?: number;
      reasoning?: string;
    }>;
    ranking?: string[];
    confidence?: number;
  } | null {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as ReturnType<CouncilOrchestrator['parseReviewJson']>;
      if (!parsed?.evaluations || !parsed.ranking || !Number.isFinite(parsed.confidence)
        || parsed.confidence! < 0 || parsed.confidence! > 1
        || parsed.ranking.length !== candidateIds.length
        || new Set(parsed.ranking).size !== candidateIds.length
        || candidateIds.some(id => !parsed.ranking!.includes(id))) return null;
      const dimensions = ['correctness', 'evidence_quality', 'completeness', 'risk_score', 'policy_compliance'] as const;
      if (candidateIds.some(id => {
        const evaluation = parsed.evaluations!.find(item => item.candidate === id);
        return !evaluation || typeof evaluation.reasoning !== 'string' || !evaluation.reasoning.trim()
          || dimensions.some(key => !Number.isFinite(evaluation[key]) || evaluation[key]! < 1 || evaluation[key]! > 5);
      })) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private executeSynthesizePhase(sessionId: string): { output: string; confidence: number } {
    const aggregated = this.evaluator.aggregateScores(sessionId, 'weighted_borda');
    const disagreement = this.evaluator.calculateDisagreement(sessionId);

    const session = this.getSession(sessionId);
    const divergeOutputs = this.getSessionOutputs(sessionId).filter(output => output.phase === 'diverge');
    if (!aggregated.length) {
      if (session.mode !== 'fast' || divergeOutputs.length !== 1) throw new Error('COUNCIL_NO_VALID_EVALUATIONS');
      return {
        output: JSON.stringify({
          conclusion: divergeOutputs[0].content,
          confidence: 0,
          reasoning: { method: 'single_model_no_peer_review', model: divergeOutputs[0].model },
          requires_human_review: session.risk_class === 'critical',
        }, null, 2),
        confidence: 0,
      };
    }
    const result = this.synthesizer.synthesize({
      session_id: sessionId,
      task_description: session.task_description,
      aggregated_scores: aggregated,
      outputs: divergeOutputs
        .map(({ anonymous_id, content, model }) => ({ anonymous_id, content, model })),
      evaluations: this.evaluator.getEvaluationsForSession(sessionId),
      risk_class: session.risk_class,
      disagreement_score: disagreement,
    });
    return { output: result.output, confidence: result.confidence };
  }

  private updateSessionPhase(sessionId: string, phase: CouncilPhase): void {
    this.db.prepare(`
      UPDATE council_sessions SET status = ?, updated_at = ? WHERE id = ?
    `).run(phase, new Date().toISOString(), sessionId);

    const eventMap: Record<string, string> = {
      reviewing: 'council:review:started',
      synthesizing: 'council:synthesize:started',
      completed: 'council:session:completed',
      failed: 'council:session:failed',
      escalated: 'council:session:escalated',
    };
    const eventType = eventMap[phase];
    if (eventType) {
      swarmEventBus.emit(eventType as any, { session_id: sessionId, phase });
    }
  }

  private finalizeSession(sessionId: string, output: string, confidence: number, duration: number): void {
    const outputs = this.getSessionOutputs(sessionId);
    const costPerToken = new Map(this.registry.listModels().map(m => [m.model_name, m.cost_per_1m_tokens / 1_000_000]));
    const totalTokens = outputs.reduce((s, o) => s + o.token_count, 0);
    const totalCost = outputs.reduce((s, o) => s + o.token_count * (costPerToken.get(o.model) ?? 0), 0);

    this.db.prepare(`
      UPDATE council_sessions
      SET status = 'completed', final_output = ?, final_confidence = ?,
          token_usage = ?, cost_dollars = ?, duration_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(output, confidence, totalTokens, Math.round(totalCost * 1000) / 1000, duration, new Date().toISOString(), sessionId);
  }

  private parseSession(row: any): CouncilSession {
    return {
      id: row.id,
      task_id: row.task_id,
      mode: row.mode,
      status: row.status,
      task_description: row.task_description,
      risk_class: row.risk_class,
      model_count: row.model_count,
      max_reasoning_depth: row.max_reasoning_depth,
      convergence_threshold: row.convergence_threshold,
      synthesis_model: row.synthesis_model,
      final_output: row.final_output,
      final_confidence: row.final_confidence,
      token_usage: row.token_usage,
      cost_dollars: row.cost_dollars,
      duration_ms: row.duration_ms,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseOutput(row: any): CouncilOutputRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      model: row.model,
      phase: row.phase,
      anonymous_id: row.anonymous_id,
      content: row.content,
      structured_score: row.structured_score,
      ranking_position: row.ranking_position,
      token_count: row.token_count,
      latency_ms: row.latency_ms,
      created_at: row.created_at,
    };
  }
}
