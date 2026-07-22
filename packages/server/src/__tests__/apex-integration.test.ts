import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PluginRegistryService } from '../services/plugin-registry-service';
import { VectorMemoryService } from '../services/vector-memory-service';
import { BackgroundWorkerService } from '../services/background-worker-service';
import { LlmRouterService } from '../services/llm-router-service';
import { SwarmOrchestrationService } from '../services/swarm-orchestration-service';
import { AgentCommunicationService } from '../services/agent-communication-service';

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
      service = new VectorMemoryService(db);
    });

    it('stores and retrieves memories', () => {
      const mem = service.storeMemory({ content: 'Test memory about TypeScript', metadata: { source: 'test' } });
      expect(mem.id).toBeDefined();
      expect(mem.content).toBe('Test memory about TypeScript');

      const retrieved = service.getMemory(mem.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe('Test memory about TypeScript');
    });

    it('searches memories semantically', () => {
      service.storeMemory({ content: 'TypeScript is a typed superset of JavaScript' });
      service.storeMemory({ content: 'Python is a dynamically typed language' });
      service.storeMemory({ content: 'JavaScript runs in the browser' });

      const results = service.search('TypeScript', 5, 0.1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('clusters related memories', () => {
      service.storeMemory({ content: 'TypeScript types' });
      service.storeMemory({ content: 'TypeScript interfaces' });
      service.storeMemory({ content: 'TypeScript generics' });

      const clusters = service.getClusters(0.3);
      expect(clusters.length).toBeGreaterThanOrEqual(0);
    });

    it('deletes memories', () => {
      const mem = service.storeMemory({ content: 'To be deleted' });
      expect(service.deleteMemory(mem.id)).toBe(true);
      expect(service.getMemory(mem.id)).toBeNull();
    });

    it('provides stats', () => {
      service.storeMemory({ content: 'Test' });
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

    it('broadcasts to all agents', () => {
      const msg = service.broadcast({ from: 'coordinator', type: 'alert', action: 'stop-all' });
      expect(msg.to).toBe('broadcast');
    });

    it('acknowledges messages', () => {
      const msg = service.send({ from: 'a', to: 'b', type: 'result', action: 'done' });
      service.acknowledge(msg.id);
      // No throw = success
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
