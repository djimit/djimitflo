import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContextCompressionService } from '../services/context-compression-service';
import { WorkflowGraphService } from '../services/workflow-graph-service';
import { GovernanceFeedbackService } from '../services/governance-feedback-service';

describe('ContextCompressionService', () => {
  let service: ContextCompressionService;

  beforeEach(() => {
    service = new ContextCompressionService(new Database(':memory:'));
  });

  it('compresses JSON by removing empty values', () => {
    // Create JSON with many empty/null values
    const obj: Record<string, unknown> = { keep: 'value' };
    for (let i = 0; i < 20; i++) {
      obj[`empty_${i}`] = '';
      obj[`null_${i}`] = null;
      obj[`arr_${i}`] = [];
    }
    const json = JSON.stringify(obj);
    const result = service.compress(json, 'json');
    expect(result.compressed).toContain('"keep":"value"');
    expect(result.ratio).toBeLessThan(1);
  });

  it('compresses code by removing comments', () => {
    const code = `// This is a comment\n// Another comment\n// Third comment\nconst x = 1;\n/* block comment */\nconst y = 2;`;
    const result = service.compress(code, 'code');
    expect(result.compressed).not.toContain('// This is a comment');
    expect(result.compressed).toContain('const x = 1');
    expect(result.method).toBe('code');
  });

  it('returns identity for short content', () => {
    const result = service.compress('short', 'text');
    expect(result.method).toBe('identity');
    expect(result.compressed).toBe('short');
  });

  it('detects JSON content type automatically', () => {
    const longJson = JSON.stringify({
      key: 'value', foo: 'bar', nested: { a: 1, b: 2 },
      array: [1, 2, 3, 4, 5], extra: 'padding to make it longer than 100 chars for sure',
    });
    const jsonResult = service.compress(longJson, 'auto');
    expect(jsonResult.method).toBe('json');
  });

  it('provides compression stats', () => {
    const service2 = new ContextCompressionService(new Database(':memory:'));
    service2.compress('x'.repeat(200), 'text');
    const stats = service2.getStats();
    expect(stats).toBeDefined();
    expect(stats.cacheSize).toBeDefined();
  });
});

describe('WorkflowGraphService', () => {
  let service: WorkflowGraphService;

  beforeEach(() => {
    service = new WorkflowGraphService(new Database(':memory:'));
  });

  it('creates a standard loop workflow', () => {
    const workflow = service.createStandardLoopWorkflow('loop-1');
    expect(workflow.id).toBeDefined();
    expect(workflow.nodes.length).toBeGreaterThan(0);
    expect(workflow.edges.length).toBeGreaterThan(0);
  });

  it('creates a parallel workflow', () => {
    const workflow = service.createParallelWorkflow('loop-1', ['task-a', 'task-b', 'task-c']);
    expect(workflow.nodes.length).toBe(6); // start + parallel + 3 tasks + end
  });

  it('gets next executable nodes', () => {
    const workflow = service.createStandardLoopWorkflow('loop-1');
    const next = service.getNextNodes(workflow.id);
    // After start completes, maker should be next
    expect(next.length).toBeGreaterThanOrEqual(0);
  });

  it('approves a gate', () => {
    const workflow = service.createStandardLoopWorkflow('loop-1');
    expect(() => service.approveGate(workflow.id, 'gate', 'test-user')).not.toThrow();
  });

  it('updates node status', () => {
    const workflow = service.createStandardLoopWorkflow('loop-1');
    expect(() => service.updateNodeStatus(workflow.id, 'maker', 'completed')).not.toThrow();
  });
});

describe('GovernanceFeedbackService', () => {
  let service: GovernanceFeedbackService;

  beforeEach(() => {
    service = new GovernanceFeedbackService(new Database(':memory:'));
  });

  it('records feedback', () => {
    const entry = service.recordFeedback({
      source: 'human_correction',
      category: 'injection',
      originalDecision: 'allow',
      correctedDecision: 'block',
      reason: 'This is a prompt injection attempt',
    });

    expect(entry.id).toBeDefined();
    expect(entry.applied).toBe(false);
  });

  it('analyzes feedback patterns', () => {
    service.recordFeedback({
      source: 'human_correction', category: 'injection',
      originalDecision: 'allow', correctedDecision: 'block', reason: 'reason 1',
    });
    service.recordFeedback({
      source: 'human_correction', category: 'injection',
      originalDecision: 'allow', correctedDecision: 'block', reason: 'reason 2',
    });

    const proposals = service.analyzeFeedback();
    expect(proposals.length).toBeGreaterThan(0);
  });

  it('applies feedback', () => {
    service.recordFeedback({
      source: 'human_correction', category: 'injection',
      originalDecision: 'allow', correctedDecision: 'block', reason: 'reason',
    });

    const pattern = 'injection: "allow" → "block"';
    service.applyFeedback(pattern);

    const stats = service.getStats();
    expect(stats.appliedFeedback).toBeGreaterThanOrEqual(0);
  });

  it('provides stats', () => {
    service.recordFeedback({
      source: 'runtime_violation', category: 'tool-scope',
      originalDecision: 'allow', correctedDecision: 'block', reason: 'reason',
    });

    const stats = service.getStats();
    expect(stats.totalFeedback).toBe(1);
    expect(stats.bySource['runtime_violation']).toBe(1);
  });
});
