import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { LiveCanvasService } from '../services/live-canvas-service';
import { TelegramBotService } from '../services/telegram-bot-service';

describe('LiveCanvasService', () => {
  let db: Database.Database;
  let service: LiveCanvasService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new LiveCanvasService(db);
  });

  it('creates a canvas session', () => {
    const session = service.createSession('run-1');
    expect(session.id).toBeDefined();
    expect(session.runId).toBe('run-1');
    expect(session.status).toBe('active');
  });

  it('gets session status', () => {
    service.createSession('run-1');
    const status = service.getSessionStatus('run-1');
    expect(status).toBeDefined();
    expect(status?.status).toBe('active');
  });

  it('returns null for non-existent session', () => {
    expect(service.getSessionStatus('nonexistent')).toBeNull();
  });

  it('streams thinking messages', () => {
    service.createSession('run-1');
    expect(() => service.streamThinking('run-1', 'Analyzing...')).not.toThrow();
    const status = service.getSessionStatus('run-1');
    expect(status?.messageCount).toBe(1);
  });

  it('streams tool calls', () => {
    service.createSession('run-1');
    expect(() => service.streamToolCall('run-1', 'grep', { pattern: 'test' })).not.toThrow();
    const status = service.getSessionStatus('run-1');
    expect(status?.messageCount).toBe(1);
  });

  it('streams tool results', () => {
    service.createSession('run-1');
    expect(() => service.streamToolResult('run-1', 'grep', 'match found')).not.toThrow();
  });

  it('streams code diffs', () => {
    service.createSession('run-1');
    expect(() => service.streamCodeDiff('run-1', 'file.ts', '+ line added')).not.toThrow();
  });

  it('streams progress', () => {
    service.createSession('run-1');
    expect(() => service.streamProgress('run-1', 5, 10, 'Processing')).not.toThrow();
  });

  it('completes session', () => {
    service.createSession('run-1');
    service.completeSession('run-1', 'All done');
    const status = service.getSessionStatus('run-1');
    expect(status?.status).toBe('completed');
  });

  it('lists sessions', () => {
    service.createSession('run-1');
    service.createSession('run-2');
    const sessions = service.listSessions();
    expect(sessions.length).toBe(2);
  });
});

describe('TelegramBotService', () => {
  let db: Database.Database;
  let service: TelegramBotService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE goals (id TEXT PRIMARY KEY);
      CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT, approved_at TEXT);
    `);
    service = new TelegramBotService(db);
  });

  it('is not configured by default', () => {
    expect(service.isConfigured()).toBe(false);
  });

  it('is configured after setup', () => {
    service.configure({ botToken: 'test-token', allowedUsers: [123] });
    expect(service.isConfigured()).toBe(true);
  });

  it('handles webhook without configured bot', async () => {
    await expect(service.handleWebhook({ message: { chat: { id: 1 }, from: { id: 1 }, text: '/start', message_id: 1 } })).resolves.not.toThrow();
  });

  it('broadcasts alerts to configured users', async () => {
    service.configure({ botToken: 'mock-token', allowedUsers: [123, 456] });
    // Will fail to actually send but should not throw
    await expect(service.broadcastAlert('Test alert')).resolves.not.toThrow();
  });
});
