import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import { CouncilRegistry, type CouncilSelection, type CouncilModelRecord } from './council-registry';
import { TaskRouter, type TaskClassification } from './task-router';
import { StructuredEvaluator, type EvaluationScores, type AggregatedScore } from './structured-evaluator';
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
  constructor(private db: Database) {
    this.registry = new CouncilRegistry(db);
    this.router = new TaskRouter();
    this.evaluator = new StructuredEvaluator(db);
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
      JSON.stringify({ classification, reasoning_classification: classification.reasoning }),
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

    try {
      const selection = this.registry.selectModelsForCouncil({
        mode: session.mode as CouncilMode,
        risk_class: session.risk_class as any,
        max_cost: 1.0,
      });

      swarmEventBus.emit('council:diverge:started', {
        session_id: sessionId,
        models: selection.models.map(m => m.model_name),
      });

      const divergeOutputs = await this.executeDivergePhase(sessionId, session.task_description, selection);
      this.updateSessionPhase(sessionId, 'reviewing');

      swarmEventBus.emit('council:review:started', { session_id: sessionId });

      await this.executeReviewPhase(sessionId, session.task_description, selection, divergeOutputs);
      this.updateSessionPhase(sessionId, 'synthesizing');

      swarmEventBus.emit('council:synthesize:started', { session_id: sessionId });

      const synthesis = this.executeSynthesizePhase(sessionId, selection);

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
        body: JSON.stringify({ model: model.model_name, prompt, stream: false }),
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

      const result = await this.callModel(model, prompt);

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
  ): Promise<void> {
    await Promise.all(selection.models.map(async (evaluatorModel) => {
      const candidates = divergeOutputs.filter(o => o.model !== evaluatorModel.model_name);
      if (candidates.length === 0) return;

      const prompt = [
        'You are an impartial reviewer on an anonymous model council. Score each candidate answer to the task on a 1-5 scale per dimension.',
        `Task:\n${taskDescription}`,
        ...candidates.map(c => `Candidate ${c.anonymous_id}:\n${c.content}`),
        'Respond with ONLY a JSON object, no prose, in this exact shape:',
        `{"evaluations":[{"candidate":"A","correctness":4,"evidence_quality":3,"completeness":4,"risk_score":4,"policy_compliance":5,"reasoning":"one sentence"}],"ranking":["A","B"],"confidence":0.8}`,
      ].join('\n\n');

      const result = await this.callModel(evaluatorModel, prompt);
      const parsed = this.parseReviewJson(result.content);
      const ranking = parsed?.ranking?.length ? parsed.ranking : candidates.map(c => c.anonymous_id);

      for (const candidate of candidates) {
        const evaluation = parsed?.evaluations?.find(e => e.candidate === candidate.anonymous_id);
        // ponytail: unparseable reviewer output falls back to neutral 3s, upgrade to a re-prompt if it happens often
        const scores: EvaluationScores = {
          correctness: evaluation?.correctness ?? 3,
          evidence_quality: evaluation?.evidence_quality ?? 3,
          completeness: evaluation?.completeness ?? 3,
          risk_score: evaluation?.risk_score ?? 3,
          policy_compliance: evaluation?.policy_compliance ?? 3,
        };

        this.evaluator.storeEvaluation({
          session_id: sessionId,
          evaluator_model: evaluatorModel.model_name,
          candidate_id: candidate.anonymous_id,
          scores,
          ranking,
          confidence: parsed?.confidence ?? 0.5,
          reasoning: evaluation?.reasoning ?? `Unparseable review output from ${evaluatorModel.model_name}`,
        });
      }
    }));

    swarmEventBus.emit('council:review:completed', {
      session_id: sessionId,
      evaluator_count: selection.models.length,
    });
  }

  private parseReviewJson(content: string): {
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
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  private executeSynthesizePhase(
    sessionId: string,
    selection: CouncilSelection,
  ): { output: string; confidence: number } {
    const aggregated = this.evaluator.aggregateScores(sessionId, 'weighted_borda');
    const disagreement = this.evaluator.calculateDisagreement(sessionId);

    const topCandidates = aggregated.slice(0, 3);
    const avgScore = topCandidates.length > 0
      ? topCandidates.reduce((s, c) => s + c.weighted_score, 0) / topCandidates.length
      : 0;

    const confidence = Math.round((avgScore / 5 * (1 - disagreement / 5)) * 100) / 100;

    const output = {
      top_ranked: topCandidates.map(c => ({
        candidate: c.candidate_id,
        score: c.weighted_score,
        agreement: c.agreement,
      })),
      disagreement_score: disagreement,
      synthesis_method: 'weighted_borda',
      model_count: selection.models.length,
      privacy_class: selection.models[0]?.privacy_class ?? 'public_api',
    };

    return { output: JSON.stringify(output, null, 2), confidence };
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
