import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CouncilRegistry } from '../services/council-registry';
import { TaskRouter } from '../services/task-router';
import { StructuredEvaluator } from '../services/structured-evaluator';
import { CouncilOrchestrator } from '../services/council-orchestrator';
import { ReasoningLoop, ConvergenceDetector } from '../services/reasoning-loop';
import { SynthesisEngine } from '../services/synthesis-engine';
import { schema } from '../database/schema';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
});

afterEach(() => {
  db.close();
});

describe('CouncilRegistry', () => {
  let registry: CouncilRegistry;

  beforeEach(() => {
    registry = new CouncilRegistry(db);
  });

  it('registers a model', () => {
    const model = registry.registerModel({
      provider: 'ollama',
      model_name: 'llama3.1:8b',
      capabilities: ['text', 'code'],
      reasoning_depth: 2,
      cost_per_1m_tokens: 0,
      privacy_class: 'local',
      independence_score: 0.8,
    });

    expect(model.id).toBeTruthy();
    expect(model.provider).toBe('ollama');
    expect(model.model_name).toBe('llama3.1:8b');
    expect(model.privacy_class).toBe('local');
  });

  it('lists active models', () => {
    registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b' });
    registry.registerModel({ provider: 'openai', model_name: 'gpt-4o' });

    const models = registry.listModels('active');
    expect(models.length).toBe(2);
  });

  it('selects diverse models for council', () => {
    registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b', privacy_class: 'local', independence_score: 0.9 });
    registry.registerModel({ provider: 'openai', model_name: 'gpt-4o', privacy_class: 'public_api', independence_score: 0.7 });
    registry.registerModel({ provider: 'anthropic', model_name: 'claude-3-5-sonnet', privacy_class: 'public_api', independence_score: 0.8 });
    registry.registerModel({ provider: 'google', model_name: 'gemini-1.5-pro', privacy_class: 'public_api', independence_score: 0.75 });

    const selection = registry.selectModelsForCouncil({
      mode: 'council',
      risk_class: 'high',
    });

    expect(selection.models.length).toBeGreaterThanOrEqual(3);
    expect(selection.diversity_score).toBeGreaterThan(0);
  });

  it('deprecates a model', () => {
    const model = registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b' });
    registry.deprecateModel(model.id);

    const models = registry.listModels('active');
    expect(models.length).toBe(0);

    const deprecated = registry.listModels('deprecated');
    expect(deprecated.length).toBe(1);
  });

  it('updates model stats', () => {
    const model = registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b' });
    registry.updateModelStats(model.id, 1000, 3000);

    const updated = registry.getModel(model.id);
    expect(updated.total_sessions).toBe(1);
    expect(updated.total_tokens).toBe(1000);
    expect(updated.avg_latency_ms).toBe(3000);
  });
});

describe('TaskRouter', () => {
  let router: TaskRouter;

  beforeEach(() => {
    router = new TaskRouter();
  });

  it('classifies simple tasks as fast mode', () => {
    const result = router.classify({ description: 'What is 2+2?' });
    expect(result.mode).toBe('fast');
    expect(result.model_count).toBe(1);
  });

  it('classifies complex architecture tasks as council mode', () => {
    const result = router.classify({
      description: 'Design a distributed microservices architecture for the payment processing system',
      risk_class: 'high',
    });
    expect(result.mode).toBe('council');
    expect(result.model_count).toBeGreaterThanOrEqual(3);
  });

  it('classifies medium complexity as review mode', () => {
    const result = router.classify({
      description: 'Review the authentication module for improvements',
    });
    expect(result.mode).toBe('review');
    expect(result.model_count).toBe(2);
  });

  it('requires human approval for critical risk', () => {
    const result = router.classify({
      description: 'GDPR compliance audit for customer data processing',
      risk_class: 'critical',
    });
    expect(result.requires_human_approval).toBe(true);
  });

  it('requires local model for privacy sensitive tasks', () => {
    const result = router.classify({
      description: 'Process customer PII data for analysis',
      privacy_sensitive: true,
    });
    expect(result.privacy_required).toBe('local');
  });

  it('classifies realtime tasks as fast regardless of complexity', () => {
    const result = router.classify({
      description: 'Design a distributed architecture',
      realtime: true,
    });
    expect(result.mode).toBe('fast');
  });
});

describe('StructuredEvaluator', () => {
  let evaluator: StructuredEvaluator;
  let sessionId: string;

  beforeEach(() => {
    evaluator = new StructuredEvaluator(db);
    // Create a session to satisfy FK constraint
    const row = db.prepare(`INSERT INTO council_sessions (id, mode, status, task_description, risk_class, model_count, max_reasoning_depth, convergence_threshold, metadata, created_at, updated_at) VALUES (?, 'fast', 'diverging', 'test', 'low', 1, 1, 0.75, '{}', datetime('now'), datetime('now'))`).run('test-session');
    sessionId = 'test-session';
  });

  it('stores evaluations', () => {
    const result = evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'gpt-4o',
      candidate_id: 'A',
      scores: { correctness: 4, evidence_quality: 3, completeness: 5, risk_score: 2, policy_compliance: 4 },
      ranking: ['A', 'B', 'C'],
      confidence: 0.85,
      reasoning: 'Strong technical answer with good evidence',
    });

    expect(result.id).toBeTruthy();
    expect(result.scores.correctness).toBe(4);
    expect(result.confidence).toBe(0.85);
  });

  it('aggregates scores with weighted borda', () => {
    evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'gpt-4o',
      candidate_id: 'A',
      scores: { correctness: 5, evidence_quality: 4, completeness: 5, risk_score: 1, policy_compliance: 5 },
      ranking: ['A', 'B', 'C'],
      confidence: 0.9,
      reasoning: 'Excellent',
    });

    evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'gpt-4o',
      candidate_id: 'B',
      scores: { correctness: 3, evidence_quality: 3, completeness: 3, risk_score: 3, policy_compliance: 3 },
      ranking: ['A', 'B', 'C'],
      confidence: 0.8,
      reasoning: 'Average',
    });

    evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'claude-3-5-sonnet',
      candidate_id: 'A',
      scores: { correctness: 4, evidence_quality: 5, completeness: 4, risk_score: 2, policy_compliance: 4 },
      ranking: ['A', 'C', 'B'],
      confidence: 0.85,
      reasoning: 'Very good',
    });

    const aggregated = evaluator.aggregateScores(sessionId, 'weighted_borda');
    expect(aggregated.length).toBe(2);
    expect(aggregated[0].candidate_id).toBe('A');
    expect(aggregated[0].rank).toBe(1);
    expect(aggregated[0].weighted_score).toBeGreaterThan(aggregated[1].weighted_score);
  });

  it('calculates disagreement', () => {
    evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'gpt-4o',
      candidate_id: 'A',
      scores: { correctness: 5, evidence_quality: 5, completeness: 5, risk_score: 1, policy_compliance: 5 },
      ranking: ['A', 'B'],
      confidence: 0.9,
      reasoning: 'Perfect',
    });

    evaluator.storeEvaluation({
      session_id: sessionId,
      evaluator_model: 'claude-3-5-sonnet',
      candidate_id: 'A',
      scores: { correctness: 1, evidence_quality: 1, completeness: 1, risk_score: 5, policy_compliance: 1 },
      ranking: ['B', 'A'],
      confidence: 0.9,
      reasoning: 'Terrible',
    });

    const disagreement = evaluator.calculateDisagreement(sessionId);
    expect(disagreement).toBeGreaterThan(0);
  });
});

describe('ReasoningLoop & ConvergenceDetector', () => {
  it('detects convergence', () => {
    const detector = new ConvergenceDetector();
    const metrics = detector.analyze([1, 2, 2.5, 2.6, 2.61]);

    expect(metrics.is_stable).toBe(true);
    expect(metrics.recommended_depth).toBeLessThanOrEqual(5);
  });

  it('detects divergence', () => {
    const detector = new ConvergenceDetector();
    const metrics = detector.analyze([1, 3, 2, 4, 1]);

    expect(metrics.is_stable).toBe(false);
  });

  it('detects overthinking', () => {
    const loop = new ReasoningLoop({ max_depth: 10, convergence_threshold: 0.01, injection_strength: 0.3 });
    const overthinking = loop.detectOverthinking([1, 2, 3, 4, 5, 3]);

    expect(overthinking).toBe(true);
  });

  it('should not continue when converged', () => {
    const loop = new ReasoningLoop({ max_depth: 10, convergence_threshold: 0.1, injection_strength: 0.3 });
    const shouldContinue = loop.shouldContinue([1, 2, 3, 3.01, 3.011]);

    expect(shouldContinue).toBe(false);
  });

  it('should continue when not converged', () => {
    const loop = new ReasoningLoop({ max_depth: 10, convergence_threshold: 0.01, injection_strength: 0.3 });
    const shouldContinue = loop.shouldContinue([1, 2, 3]);

    expect(shouldContinue).toBe(true);
  });

  it('stops at max depth', () => {
    const loop = new ReasoningLoop({ max_depth: 3, convergence_threshold: 0.01, injection_strength: 0.3 });
    const shouldContinue = loop.shouldContinue([1, 2, 3]);

    expect(shouldContinue).toBe(false);
  });
});

describe('CouncilOrchestrator', () => {
  let orchestrator: CouncilOrchestrator;
  let registry: CouncilRegistry;

  beforeEach(() => {
    orchestrator = new CouncilOrchestrator(db);
    registry = new CouncilRegistry(db);

    registry.registerModel({ provider: 'ollama', model_name: 'llama3.1:8b', privacy_class: 'local', independence_score: 0.9, avg_governance_score: 3.5 });
    registry.registerModel({ provider: 'openai', model_name: 'gpt-4o', privacy_class: 'public_api', independence_score: 0.7, avg_governance_score: 4.2 });
    registry.registerModel({ provider: 'anthropic', model_name: 'claude-3-5-sonnet', privacy_class: 'public_api', independence_score: 0.8, avg_governance_score: 4.0 });
    registry.registerModel({ provider: 'google', model_name: 'gemini-1.5-pro', privacy_class: 'public_api', independence_score: 0.75, avg_governance_score: 3.8 });
  });

  it('creates a session', async () => {
    const session = await orchestrator.createSession({
      task_description: 'Design a secure authentication system',
      mode: 'council',
      risk_class: 'high',
    });

    expect(session.id).toBeTruthy();
    expect(session.mode).toBe('council');
    expect(session.status).toBe('diverging');
  });

  it('auto-classifies task and creates session', async () => {
    const session = await orchestrator.createSession({
      task_description: 'Perform a threat model analysis of the payment processing microservice architecture',
    });

    expect(session.id).toBeTruthy();
    expect(session.model_count).toBeGreaterThanOrEqual(2);
  });

  it('gets session status', async () => {
    const session = await orchestrator.createSession({
      task_description: 'Simple math question: what is 2+2?',
    });

    const status = orchestrator.getSessionStatus(session.id);
    expect(status.session.id).toBe(session.id);
    expect(status.phase).toBe('diverging');
  });

  it('lists sessions', async () => {
    await orchestrator.createSession({ task_description: 'Task 1' });
    await orchestrator.createSession({ task_description: 'Task 2' });

    const sessions = orchestrator.listSessions(10);
    expect(sessions.length).toBe(2);
  });
});

describe('SynthesisEngine', () => {
  let engine: SynthesisEngine;
  let sessionId: string;

  beforeEach(() => {
    engine = new SynthesisEngine(db);
    db.prepare(`INSERT INTO council_sessions (id, mode, status, task_description, risk_class, model_count, max_reasoning_depth, convergence_threshold, metadata, created_at, updated_at) VALUES (?, 'fast', 'diverging', 'test', 'low', 1, 1, 0.75, '{}', datetime('now'), datetime('now'))`).run('test-session');
    sessionId = 'test-session';
  });

  it('synthesizes results', () => {
    const result = engine.synthesize({
      session_id: sessionId,
      task_description: 'Test task',
      aggregated_scores: [
        { candidate_id: 'A', weighted_score: 4.5, rank: 1, scores: { correctness: 5, evidence_quality: 4, completeness: 5, risk_score: 1, policy_compliance: 5 }, agreement: 0.9 },
        { candidate_id: 'B', weighted_score: 3.0, rank: 2, scores: { correctness: 3, evidence_quality: 3, completeness: 3, risk_score: 3, policy_compliance: 3 }, agreement: 0.7 },
      ],
      outputs: [
        { anonymous_id: 'A', content: 'Answer A', model: 'gpt-4o' },
        { anonymous_id: 'B', content: 'Answer B', model: 'claude' },
      ],
      evaluations: [
        { candidate_id: 'A', reasoning: 'Excellent', scores: { correctness: 5 } },
        { candidate_id: 'B', reasoning: 'Average', scores: { correctness: 3 } },
      ],
      risk_class: 'medium',
      disagreement_score: 1.5,
    });

    expect(result.id).toBeTruthy();
    expect(result.top_candidate).toBe('A');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.output).toBeTruthy();
  });

  it('flags critical risk for human review', () => {
    const result = engine.synthesize({
      session_id: sessionId,
      task_description: 'Critical task',
      aggregated_scores: [
        { candidate_id: 'A', weighted_score: 4.0, rank: 1, scores: { correctness: 4, evidence_quality: 4, completeness: 4, risk_score: 1, policy_compliance: 4 }, agreement: 0.8 },
      ],
      outputs: [{ anonymous_id: 'A', content: 'Answer', model: 'gpt-4o' }],
      evaluations: [{ candidate_id: 'A', reasoning: 'Good', scores: { correctness: 4 } }],
      risk_class: 'critical',
      disagreement_score: 0.5,
    });

    expect(result.policy_flags).toContain('CRITICAL_RISK: Human approval mandatory');
  });

  it('flags high disagreement', () => {
    const result = engine.synthesize({
      session_id: sessionId,
      task_description: 'Controversial task',
      aggregated_scores: [
        { candidate_id: 'A', weighted_score: 3.0, rank: 1, scores: { correctness: 3, evidence_quality: 3, completeness: 3, risk_score: 3, policy_compliance: 3 }, agreement: 0.3 },
      ],
      outputs: [{ anonymous_id: 'A', content: 'Answer', model: 'gpt-4o' }],
      evaluations: [{ candidate_id: 'A', reasoning: 'Mixed', scores: { correctness: 3 } }],
      risk_class: 'medium',
      disagreement_score: 3.5,
    });

    expect(result.policy_flags).toContain('HIGH_DISAGREEMENT: Results unreliable without human review');
  });
});
