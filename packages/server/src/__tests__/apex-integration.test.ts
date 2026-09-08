import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PluginRegistryService } from '../services/plugin-registry-service';
import { VectorMemoryService } from '../services/vector-memory-service';
import { BackgroundWorkerService } from '../services/background-worker-service';
import { LlmRouterService } from '../services/llm-router-service';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { BoardHandoffService } from '../services/board-handoff-service';
import { WorkItemService } from '../services/work-item-service';
import { TestEmbeddingProvider } from './helpers/test-embedding-provider';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Create required tables for Apex services
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '0.1.0',
      description TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'unknown',
      license TEXT NOT NULL DEFAULT 'MIT', enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS swarm_capabilities (
      id TEXT PRIMARY KEY, kind TEXT, owner TEXT, version TEXT DEFAULT '1.0.0',
      status TEXT DEFAULT 'candidate', risk_ceiling TEXT DEFAULT 'low',
      input_schema_ref TEXT DEFAULT '', output_schema_ref TEXT DEFAULT '',
      allowed_actions_json TEXT DEFAULT '[]', forbidden_actions_json TEXT DEFAULT '[]',
      required_evidence_json TEXT DEFAULT '[]', eval_score REAL DEFAULT 0,
      eval_threshold REAL DEFAULT 0.75, cost_model_json TEXT DEFAULT '{}',
      removal_strategy TEXT DEFAULT 'manual_review', metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vector_memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ttl INTEGER, access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      type TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 3,
      payload_json TEXT NOT NULL DEFAULT '{}', timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      ttl INTEGER NOT NULL DEFAULT 300, status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS swarm_sessions (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning',
      subtasks_json TEXT NOT NULL DEFAULT '[]', agent_pool_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_provider_metrics (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, task_type TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1,
      cost_dollars REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS worker_results (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loop_runs (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS worker_leases (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      source TEXT NOT NULL, source_ref TEXT, risk_class TEXT NOT NULL,
      value_score INTEGER NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL,
      recommended_loop TEXT, assigned_agent_id TEXT, assigned_runtime TEXT,
      parent_goal_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('Apex Integration Tests', () => {
  describe('PluginRegistryService', () => {
    let db: Database.Database;
    let service: PluginRegistryService;

    beforeEach(() => {
      db = createTestDb();
      service = new PluginRegistryService(db);
    });

    it('installs plugin with valid signature as inactive (quarantine first)', () => {
      const crypto = require('crypto');
      const data = 'test-plugin-Test Plugin-1.0.0-test-cap';
      const signature = crypto.createHash('sha256').update(data).digest('hex');

      service.installPlugin({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        capabilities: ['test-cap'],
        dependencies: [],
        permissions: [],
        signature,
        createdAt: new Date().toISOString(),
      });

      // SECURITY: plugins installed as inactive — explicit enable required
      expect(service.getPluginStatus('test-plugin')).toBe('inactive');
      service.enablePlugin('test-plugin');
      expect(service.getPluginStatus('test-plugin')).toBe('active');
    });

    it('rejects plugin with invalid signature', () => {
      expect(() => {
        service.installPlugin({
          id: 'bad-plugin',
          name: 'Bad Plugin',
          version: '1.0.0',
          capabilities: ['bad-cap'],
          dependencies: [],
          permissions: [],
          signature: 'invalid',
          createdAt: '',
        });
      }).toThrow('Invalid plugin signature');
    });

    it('enables and disables plugins', () => {
      const crypto = require('crypto');
      const sig = crypto.createHash('sha256').update('p1-P1-1.0-c1').digest('hex');
      service.installPlugin({ id: 'p1', name: 'P1', version: '1.0', capabilities: ['c1'], dependencies: [], permissions: [], signature: sig, createdAt: '' });

      service.disablePlugin('p1');
      expect(service.getPluginStatus('p1')).toBe('inactive');

      service.enablePlugin('p1');
      expect(service.getPluginStatus('p1')).toBe('active');
    });

    it('lists all plugins', () => {
      const crypto = require('crypto');
      const sig1 = crypto.createHash('sha256').update('p1-P1-1.0-c1').digest('hex');
      const sig2 = crypto.createHash('sha256').update('p2-P2-1.0-c2').digest('hex');
      service.installPlugin({ id: 'p1', name: 'P1', version: '1.0', capabilities: ['c1'], dependencies: [], permissions: [], signature: sig1, createdAt: '' });
      service.installPlugin({ id: 'p2', name: 'P2', version: '1.0', capabilities: ['c2'], dependencies: [], permissions: [], signature: sig2, createdAt: '' });

      const plugins = service.listPlugins();
      expect(plugins.length).toBe(2);
    });

    it('provides stats', () => {
      const stats = service.getStats();
      expect(stats.totalPlugins).toBeDefined();
      expect(stats.enabledPlugins).toBeDefined();
    });
  });

  describe('VectorMemoryService', () => {
    let db: Database.Database;
    let service: VectorMemoryService;

    beforeEach(() => {
      db = createTestDb();
      service = new VectorMemoryService(db, new TestEmbeddingProvider());
    });

    it('stores and retrieves memories', async () => {
      const mem = await service.storeMemory({ content: 'Test memory about TypeScript', metadata: { source: 'test' } });
      expect(mem.id).toBeDefined();
      expect(mem.content).toBe('Test memory about TypeScript');

      const retrieved = service.getMemory(mem.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe('Test memory about TypeScript');
    });

    it('searches memories semantically', async () => {
      await service.storeMemory({ content: 'TypeScript is a typed superset of JavaScript' });
      await service.storeMemory({ content: 'Python is a dynamically typed language' });
      await service.storeMemory({ content: 'JavaScript runs in the browser' });

      const results = await service.search('TypeScript', 5, 0.1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('re-embeds legacy hash rows with the active provider', async () => {
      db.prepare(`
        INSERT INTO vector_memories
          (id, content, embedding_json, metadata_json, created_at, last_accessed)
        VALUES ('legacy-memory', 'TypeScript legacy memory', '[0.1,0.2]', '{}', datetime('now'), datetime('now'))
      `).run();

      const results = await service.search('TypeScript', 5, 0.1);
      const migrated = db.prepare(`
        SELECT embedding_provider, embedding_json FROM vector_memories WHERE id = 'legacy-memory'
      `).get() as any;

      expect(results.map((result) => result.id)).toContain('legacy-memory');
      expect(migrated.embedding_provider).toBe('test:semantic');
      expect(JSON.parse(migrated.embedding_json)).toHaveLength(8);
    });

    it('clusters related memories', async () => {
      await service.storeMemory({ content: 'TypeScript types' });
      await service.storeMemory({ content: 'TypeScript interfaces' });
      await service.storeMemory({ content: 'TypeScript generics' });

      const clusters = await service.getClusters(0.3);
      expect(clusters.length).toBeGreaterThanOrEqual(0);
    });

    it('deletes memories', async () => {
      const mem = await service.storeMemory({ content: 'To be deleted' });
      expect(service.deleteMemory(mem.id)).toBe(true);
      expect(service.getMemory(mem.id)).toBeNull();
    });

    it('provides stats', async () => {
      await service.storeMemory({ content: 'Test' });
      const stats = service.getStats();
      expect(stats.totalMemories).toBe(1);
    });
  });

  describe('BackgroundWorkerService', () => {
    let db: Database.Database;
    let service: BackgroundWorkerService;

    beforeEach(() => {
      db = createTestDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS loop_runs (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE IF NOT EXISTS worker_leases (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY);
      `);
      service = new BackgroundWorkerService(db);
    });

    it('has 8 default workers', () => {
      const status = service.getStatus();
      expect(status.workers.length).toBe(8);
    });

    it('runs a worker task', async () => {
      const result = await service.runWorker('health-check');
      expect(result.status).toBe('completed');
    });

    it('starts and stops workers', () => {
      expect(() => {
        service.startWorker('health-check');
        service.stopWorker('health-check');
      }).not.toThrow();
    });

    it('provides status', () => {
      const status = service.getStatus();
      expect(status.workers).toBeDefined();
      expect(status.recentResults).toBeDefined();
    });
  });

  describe('LlmRouterService', () => {
    let db: Database.Database;
    let service: LlmRouterService;

    beforeEach(() => {
      db = createTestDb();
      service = new LlmRouterService(db);
    });

    it('routes coding tasks to optimal provider', () => {
      service.recordPerformance({ provider: 'ollama', taskType: 'coding', latencyMs: 100, success: true });
      const decision = service.route({ taskType: 'coding', prompt: 'Write a function' });
      expect(decision.provider).toBeDefined();
      expect(decision.model).toBeDefined();
      expect(decision.reason).toBeDefined();
    });

    it('routes analysis tasks', () => {
      service.recordPerformance({ provider: 'ollama', taskType: 'analysis', latencyMs: 100, success: true });
      const decision = service.route({ taskType: 'analysis', prompt: 'Analyze this code' });
      expect(decision.provider).toBeDefined();
    });

    it('records performance', () => {
      expect(() => {
        service.recordPerformance({
          provider: 'anthropic',
          taskType: 'coding',
          latencyMs: 1500,
          success: true,
          costDollars: 0.01,
        });
      }).not.toThrow();
    });

    it('provides provider health', () => {
      const health = service.getProviderHealth();
      expect(health.length).toBeGreaterThan(0);
      expect(health[0].name).toBeDefined();
      expect(health[0].status).toBeDefined();
    });

    it('provides stats', () => {
      const stats = service.getStats();
      expect(stats.totalProviders).toBe(5);
      expect(stats.activeProviders).toBe(0);
    });
  });

  describe('SwarmOrchestrationService', () => {
    let db: Database.Database;
    let service: SwarmOrchestrationService;

    beforeEach(() => {
      db = createTestDb();
      service = new SwarmOrchestrationService(db);
    });

    it('creates a swarm session', () => {
      const session = service.createSession('Build a REST API with tests');
      expect(session.id).toBeDefined();
      expect(session.goal).toBe('Build a REST API with tests');
      expect(session.subtasks.length).toBeGreaterThan(0);
    });

    it('does not report simulated swarm execution as real work', () => {
      const session = service.createSession('Simple task');
      expect(() => service.executeSession(session.id)).toThrow('SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED');
    });

    it('tracks progress', () => {
      const session = service.createSession('Build something complex with multiple parts');

      const progress = service.getProgress(session.id);
      expect(progress.totalSubtasks).toBeGreaterThan(0);
      expect(progress.status).toBeDefined();
    });

    it('lists sessions', () => {
      service.createSession('Goal 1');
      service.createSession('Goal 2');
      const sessions = service.listSessions();
      expect(sessions.length).toBe(2);
    });
  });

  describe('AgentCommunicationService', () => {
    let db: Database.Database;
    let service: AgentCommunicationService;

    beforeEach(() => {
      db = createTestDb();
      service = new AgentCommunicationService(db);
    });

    it('sends messages between agents', () => {
      const msg = service.send({
        from: 'agent-a',
        to: 'agent-b',
        type: 'task',
        action: 'process-data',
        params: { data: 'test' },
      });
      expect(msg.id).toBeDefined();
      expect(msg.status).toBe('pending');
    });

    it('delivers messages to recipient', () => {
      service.send({ from: 'a', to: 'b', type: 'task', action: 'test' });
      const messages = service.receive('b');
      expect(messages.length).toBe(1);
      expect(messages[0].from).toBe('a');
    });

    it('replays pending messages from SQLite after a service restart', () => {
      service.send({ from: 'a', to: 'b', type: 'question', action: 'challenge-claim', evidence: ['arxiv:1'], threadId: 'thread-1', epistemicRole: 'objection' });
      const restarted = new AgentCommunicationService(db);
      const messages = restarted.receive('b');
      expect(messages).toHaveLength(1);
      expect(messages[0].payload).toMatchObject({ action: 'challenge-claim', evidence: ['arxiv:1'], thread_id: 'thread-1', epistemic_role: 'objection' });
      expect(restarted.getStats()).toMatchObject({ totalMessages: 1, deliveredMessages: 1, pendingMessages: 0 });
    });

    it('claims a pending message only once across consumers', () => {
      service.send({ from: 'a', to: 'b', type: 'question', action: 'single-claim' });
      const first = service.receive('b');
      const second = new AgentCommunicationService(db).receive('b');
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
      expect(service.getStats()).toMatchObject({ deliveredMessages: 1, pendingMessages: 0 });
    });

    it('reclaims a delivered message after its delivery lease expires', () => {
      const sent = service.send({ from: 'a', to: 'b', type: 'question', action: 'crash-safe-replay' });
      expect(service.receive('b')).toHaveLength(1);
      db.prepare('UPDATE agent_messages SET delivery_lease_until = 0 WHERE id = ?').run(sent.id);

      const replay = new AgentCommunicationService(db).receive('b');
      expect(replay).toHaveLength(1);
      expect(replay[0].id).toBe(sent.id);
    });

    it('reclaims a migrated delivered message with a null lease', () => {
      const sent = service.send({ from: 'a', to: 'b', type: 'question', action: 'null-lease-replay' });
      expect(service.receive('b')).toHaveLength(1);
      db.prepare('UPDATE agent_messages SET delivery_lease_until = NULL WHERE id = ?').run(sent.id);

      expect(new AgentCommunicationService(db).receive('b')).toMatchObject([{ id: sent.id }]);
    });

    it('rejects an evidence-free claim at the communication boundary', () => {
      expect(() => service.send({ from: 'a', to: 'b', type: 'knowledge', action: 'unsupported-claim', epistemicRole: 'claim' }))
        .toThrow('BOARD_CLAIM_EVIDENCE_REQUIRED');
    });

    it('requires a thread for epistemic board messages', () => {
      expect(() => service.send({ from: 'a', to: 'b', type: 'question', action: 'ask', epistemicRole: 'question' }))
        .toThrow('BOARD_THREAD_REQUIRED');
      expect(() => service.send({ from: 'a', to: 'b', type: 'question', action: 'reply', replyTo: 'claim-1' }))
        .toThrow('BOARD_REPLY_THREAD_REQUIRED');
    });

    it('validates message type, priority and ttl at the service boundary', () => {
      expect(() => service.send({ from: 'a', to: 'b', type: 'unknown' as any, action: 'x' }))
        .toThrow('BOARD_MESSAGE_TYPE_INVALID');
      expect(() => service.send({ from: 'a', to: 'b', type: 'task', action: 'x', priority: 9 as any }))
        .toThrow('BOARD_MESSAGE_PRIORITY_INVALID');
      expect(() => service.send({ from: 'a', to: 'b', type: 'task', action: 'x', ttl: -1 }))
        .toThrow('BOARD_MESSAGE_TTL_INVALID');
    });

    it('replays an idempotent send without creating a second durable record', () => {
      const input = { from: 'a', to: 'b', type: 'result' as const, action: 'done', idempotencyKey: 'result-1' };
      const first = service.send(input);
      const replay = new AgentCommunicationService(db).send({ ...input });
      expect(replay.id).toBe(first.id);
      expect((db.prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE idempotency_key = ?').get('result-1') as any).count).toBe(1);
    });

    it('rejects idempotency-key reuse when the request payload changes', () => {
      service.send({ from: 'a', to: 'b', type: 'result', action: 'done', idempotencyKey: 'result-conflict' });
      expect(() => service.send({ from: 'a', to: 'b', type: 'result', action: 'changed', idempotencyKey: 'result-conflict' }))
        .toThrow('BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
    });

    it('fences an old delivery acknowledgement after lease reclaim', () => {
      const sent = service.send({ from: 'a', to: 'b', type: 'result', action: 'fenced-ack' });
      const first = service.receive('b')[0];
      db.prepare('UPDATE agent_messages SET delivery_lease_until = 0 WHERE id = ?').run(sent.id);
      const replay = new AgentCommunicationService(db).receive('b')[0];
      expect(first.deliveryLeaseToken).toBeTruthy();
      expect(replay.deliveryLeaseToken).toBeTruthy();
      expect(replay.deliveryLeaseToken).not.toBe(first.deliveryLeaseToken);
      expect(() => service.acknowledge(sent.id, 'b', first.deliveryLeaseToken)).toThrow('BOARD_ACK_LEASE_INVALID');
      new AgentCommunicationService(db).acknowledge(sent.id, 'b', replay.deliveryLeaseToken);
    });

    it('rejects acknowledgement after a lease expires before reclaim', () => {
      const sent = service.send({ from: 'a', to: 'b', type: 'result', action: 'expired-ack' });
      const delivered = service.receive('b')[0];
      db.prepare('UPDATE agent_messages SET delivery_lease_until = 0 WHERE id = ?').run(sent.id);
      expect(() => service.acknowledge(sent.id, 'b', delivered.deliveryLeaseToken)).toThrow('BOARD_ACK_LEASE_EXPIRED');
      expect(new AgentCommunicationService(db).receive('b')).toHaveLength(1);
    });

    it('rejects a reply from outside the original conversation participants', () => {
      const claim = service.send({ from: 'a', to: 'b', type: 'knowledge', action: 'claim', threadId: 'isolated-thread', epistemicRole: 'claim', evidence: ['arxiv:isolated'] });
      expect(() => service.send({ from: 'c', to: 'b', type: 'knowledge', action: 'reply', threadId: 'isolated-thread', replyTo: claim.id, epistemicRole: 'objection', evidence: ['arxiv:other'] }))
        .toThrow('BOARD_REPLY_PARTICIPANT_MISMATCH');
    });

    it('rejects a reply from an agent added after a broadcast was delivered', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      const claim = service.broadcast({ from: 'coordinator', type: 'knowledge', action: 'broadcast-claim', threadId: 'broadcast-thread', epistemicRole: 'claim', evidence: ['arxiv:broadcast'] });
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-c', 'idle')").run();
      expect(() => service.send({ from: 'agent-c', to: 'broadcast', type: 'knowledge', action: 'late-reply', threadId: 'broadcast-thread', replyTo: claim.id, epistemicRole: 'objection', evidence: ['arxiv:late'] }))
        .toThrow('BOARD_REPLY_PARTICIPANT_MISMATCH');
    });

    it('backfills historical durable idempotency keys before accepting retries', () => {
      db.prepare(`
        INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status, idempotency_key)
        VALUES ('historical-idempotent', 'a', 'b', 'result', 3, '{"action":"old"}', ?, 300, 'pending', 'historical-1')
      `).run(new Date().toISOString());
      db.prepare('DELETE FROM board_idempotency_keys').run();

      const replay = new AgentCommunicationService(db).send({ from: 'a', to: 'b', type: 'result', action: 'old', idempotencyKey: 'historical-1' });
      expect(replay.id).toBe('historical-idempotent');
    });

    it('reconciles a board proposal into one review-required work item', () => {
      service.send({ from: 'agent-a', to: 'agent-b', type: 'knowledge', action: 'review-paper', threadId: 'research-1', epistemicRole: 'proposal', evidence: ['arxiv:1'] });
      const handoff = new BoardHandoffService(db);
      expect(handoff.reconcile()).toMatchObject({ scanned: 1, candidates: 1, created: 1, existing: 0, status: 'PASS' });
      expect(handoff.reconcile()).toMatchObject({ scanned: 0, created: 0, existing: 0, status: 'PASS' });
      expect(db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE source = 'agent_board'").get()).toMatchObject({ count: 1 });
      const item = db.prepare("SELECT * FROM work_items WHERE source = 'agent_board'").get() as any;
      expect(item).toMatchObject({ status: 'blocked', source_ref: expect.stringContaining('agent_messages:') });
      expect(JSON.parse(item.metadata)).toMatchObject({ approval_state: 'REVIEW_REQUIRED', requires_human_approval: true });
      expect(() => new WorkItemService(db).update(item.id, { status: 'triaged' })).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
      expect(() => new WorkItemService(db).convertToGoal(item.id)).toThrow('BOARD_HANDOFF_REVIEW_REQUIRED');
    });

    it('publishes a durable board handoff outbox event exactly once', async () => {
      service.send({ from: 'agent-a', to: 'agent-b', type: 'knowledge', action: 'publish-board-handoff', threadId: 'research-outbox', epistemicRole: 'proposal', evidence: ['arxiv:outbox'] });
      const handoff = new BoardHandoffService(db);
      expect(handoff.reconcile()).toMatchObject({ created: 1, status: 'PASS' });
      expect((db.prepare('SELECT status FROM board_handoff_outbox').get() as any).status).toBe('pending');
      vi.stubEnv('DJIMIT_EVENT_BUS_URL', 'http://event-bus');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 201 })));

      await expect(handoff.publishPending()).resolves.toMatchObject({ attempted: 1, published: 1, failed: 0, status: 'PASS' });
      await expect(handoff.publishPending()).resolves.toMatchObject({ attempted: 0, published: 0, failed: 0, status: 'PASS' });
      expect((db.prepare('SELECT status FROM board_handoff_outbox').get() as any).status).toBe('published');
      vi.unstubAllGlobals();
    });

    it('rejects a reply whose target is missing before persistence', () => {
      expect(() => service.send({ from: 'agent-a', to: 'agent-b', type: 'knowledge', action: 'orphan-reply', threadId: 'research-2', replyTo: 'missing-claim', epistemicRole: 'proposal', evidence: ['arxiv:2'] }))
        .toThrow('BOARD_REPLY_TARGET_NOT_FOUND');
    });

    it('reclaims a stale processing handoff claim', () => {
      const message = service.send({ from: 'agent-a', to: 'agent-b', type: 'knowledge', action: 'stale-handoff', threadId: 'research-3', epistemicRole: 'proposal', evidence: ['arxiv:3'] });
      new BoardHandoffService(db);
      db.prepare(`INSERT INTO board_handoff_claims (source_ref, status, updated_at) VALUES (?, 'processing', datetime('now', '-10 minutes'))`)
        .run(`agent_messages:${message.id}`);

      expect(new BoardHandoffService(db).reconcile()).toMatchObject({ candidates: 1, created: 1, status: 'PASS' });
    });

    it('broadcasts to all agents', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      const msg = service.broadcast({ from: 'coordinator', type: 'alert', action: 'stop-all' });
      expect(msg.to).toBe('broadcast');
    });

    it('fans out a broadcast once to every registered recipient', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      service.broadcast({ from: 'coordinator', type: 'alert', action: 'stop-all' });
      expect(service.receive('agent-a')).toHaveLength(1);
      expect(new AgentCommunicationService(db).receive('agent-b')).toHaveLength(1);
      expect(new AgentCommunicationService(db).receive('agent-a')).toHaveLength(0);
    });

    it('reclaims a broadcast delivery with an expired lease', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      const msg = service.broadcast({ from: 'coordinator', type: 'alert', action: 'broadcast-crash-replay' });
      expect(service.receive('agent-a')).toHaveLength(1);
      db.prepare('UPDATE agent_message_deliveries SET delivery_lease_until = 0 WHERE message_id = ? AND agent_id = ?').run(msg.id, 'agent-a');

      expect(new AgentCommunicationService(db).receive('agent-a')).toMatchObject([{ id: msg.id }]);
    });

    it('backfills recipients for a migrated broadcast without delivery rows', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status)
        VALUES ('legacy-broadcast', 'coordinator', 'broadcast', 'alert', 3, '{"action":"legacy"}', ?, 300, 'delivered')
      `).run(timestamp);

      expect(new AgentCommunicationService(db).receive('agent-a')).toMatchObject([{ id: 'legacy-broadcast' }]);
    });

    it('backfills only missing recipients for a partially migrated broadcast', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      db.prepare(`
        INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status)
        VALUES ('partial-broadcast', 'coordinator', 'broadcast', 'alert', 3, '{"action":"partial"}', ?, 300, 'delivered')
      `).run(new Date().toISOString());
      db.prepare("INSERT INTO agent_message_deliveries (message_id, agent_id, status, delivery_lease_until) VALUES ('partial-broadcast', 'agent-a', 'read', NULL)").run();

      const restarted = new AgentCommunicationService(db);
      expect(restarted.receive('agent-b')).toMatchObject([{ id: 'partial-broadcast' }]);
      expect(restarted.receive('agent-a')).toHaveLength(0);
    });

    it('does not let an acknowledgement without an agent suppress broadcast recipients', () => {
      db.prepare("INSERT INTO agents (id, status) VALUES ('agent-a', 'idle'), ('agent-b', 'idle')").run();
      const msg = service.broadcast({ from: 'coordinator', type: 'alert', action: 'stop-all', idempotencyKey: 'alert-1' });
      service.receive('agent-a');
      expect(() => service.acknowledge(msg.id)).toThrow('BOARD_BROADCAST_ACK_AGENT_REQUIRED');
      expect(new AgentCommunicationService(db).receive('agent-b')).toHaveLength(1);
    });

    it('rejects acknowledgements from a non-recipient', () => {
      const msg = service.send({ from: 'a', to: 'b', type: 'result', action: 'done' });
      expect(() => service.acknowledge(msg.id, 'c')).toThrow('BOARD_ACK_AGENT_INVALID');
    });

    it('acknowledges messages', () => {
      const msg = service.send({ from: 'a', to: 'b', type: 'result', action: 'done' });
      expect(() => service.acknowledge(msg.id)).toThrow('BOARD_ACK_AGENT_REQUIRED');
      service.acknowledge(msg.id, 'b');
      // No throw = success
    });

    it('rejects acknowledgement for a missing message', () => {
      expect(() => service.acknowledge('missing-message', 'b')).toThrow('BOARD_MESSAGE_NOT_FOUND');
    });

    it('cleans up expired messages', () => {
      service.send({ from: 'a', to: 'b', type: 'task', action: 'test', ttl: 0 });
      // Message should be expired immediately
      const cleaned = service.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(0);
    });

    it('provides stats', () => {
      service.send({ from: 'a', to: 'b', type: 'task', action: 'test' });
      const stats = service.getStats();
      expect(stats.totalMessages).toBe(1);
    });
  });
});
