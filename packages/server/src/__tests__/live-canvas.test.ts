import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { LiveCanvasService } from '../services/live-canvas-service';
import { TelegramBotService } from '../services/telegram-bot-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { DENNIS_AGENT_ID } from '../services/dennis-agent-service';
import { parseTelegramAllowedUsers, telegramConfigStatus } from '../routes/telegram';

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
    db.exec(schema);
    runMigrations(db);
    service = new TelegramBotService(db);
  });

  it('is not configured by default', () => {
    expect(service.isConfigured()).toBe(false);
  });

  it('is configured after setup', () => {
    service.configure({ botToken: 'test-token', allowedUsers: [123] });
    expect(service.isConfigured()).toBe(true);
  });

  it('reports Telegram readiness without exposing secrets', () => {
    expect(parseTelegramAllowedUsers(' 123, ,456,abc ')).toEqual([123, 456]);
    expect(telegramConfigStatus({}, false)).toMatchObject({
      configured: false,
      ready: false,
      allowed_user_count: 0,
      webhook_configured: false,
      missing_env: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_WEBHOOK_URL'],
    });
    expect(JSON.stringify(telegramConfigStatus({
      TELEGRAM_BOT_TOKEN: 'secret-token',
      TELEGRAM_ALLOWED_USERS: '123,456',
      TELEGRAM_WEBHOOK_URL: 'https://example.test/api/telegram/webhook',
      TELEGRAM_BOTS_CONFIG: '[{}]',
    }, true))).not.toContain('secret-token');
  });

  it('handles webhook without configured bot', async () => {
    await expect(service.handleWebhook({ message: { chat: { id: 1 }, from: { id: 1 }, text: '/start', message_id: 1 } })).resolves.not.toThrow();
  });

  it('broadcasts alerts to configured users', async () => {
    service.configure({ botToken: 'mock-token', allowedUsers: [123, 456] });
    // Will fail to actually send but should not throw
    await expect(service.broadcastAlert('Test alert')).resolves.not.toThrow();
  });

  it('creates Dennis dry-run tasks from Telegram', async () => {
    const replies: string[] = [];
    service.configure({ botToken: 'mock-token', allowedUsers: [123] });
    service.sendMessage = async (_chatId: number, text: string) => { replies.push(text); };

    await service.handleWebhook({ message: { chat: { id: 123 }, from: { id: 123 }, text: '/dennis_task Controleer alles veilig', message_id: 1 } });

    const task = db.prepare('SELECT * FROM tasks WHERE agent_id = ?').get(DENNIS_AGENT_ID) as any;
    expect(task.execution_mode).toBe('dry_run');
    expect(task.status).toBe('pending');
    expect(JSON.parse(task.metadata).autonomy_mode).toBe('dry_run_only');
    expect(replies[0]).toContain('Dennis dry\\-run task aangemaakt');
  });

  it('reports Dennis Telegram status without granting live mutation rights', async () => {
    const replies: string[] = [];
    service.configure({ botToken: 'mock-token', allowedUsers: [123] });
    service.sendMessage = async (_chatId: number, text: string) => { replies.push(text); };

    await service.handleWebhook({ message: { chat: { id: 123 }, from: { id: 123 }, text: '/dennis', message_id: 1 } });

    expect(replies[0]).toContain('Dennis Agent');
    expect(replies[0]).toContain('Access: 10 read scopes, 7 safe actions, 9 gated actions');
    expect(replies[0]).toContain('Act: dry\\-run tasks');
    expect(replies[0]).toContain('only after approval');
  });

  it('materializes approved Dennis dry-run evidence from Telegram approval', async () => {
    const replies: string[] = [];
    const now = new Date().toISOString();
    const taskId = 'dennis-task-approval-test';
    const approvalId = 'dennis-approval-test';
    service.configure({ botToken: 'mock-token', allowedUsers: [123] });
    service.sendMessage = async (_chatId: number, text: string) => { replies.push(text); };
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, created_at, updated_at)
      VALUES (?, 'Dennis Agent', 'Safe-mode Dennis operator agent.', 'active', ?, ?, ?)
    `).run(DENNIS_AGENT_ID, JSON.stringify(['paperclip-dry-run']), now, now);
    db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, risk_level, execution_mode,
        agent_id, tags, metadata, created_at, updated_at
      ) VALUES (?, 'Approved dry-run', 'Dry-run evidence', 'completed', 'medium', 'medium', 'dry_run', ?, ?, ?, ?, ?)
    `).run(
      taskId,
      DENNIS_AGENT_ID,
      JSON.stringify(['telegram', 'dennis-agent']),
      JSON.stringify({ autonomy_mode: 'dry_run_only', dry_run_plan: { gates: ['human_approval_required_before_execution'] } }),
      now,
      now,
    );
    db.prepare(`
      INSERT INTO approvals (
        id, task_id, status, risk_level, request_type, request_message, request_data, metadata, created_at, updated_at
      ) VALUES (?, ?, 'pending', 'medium', 'high_risk_action', 'Approve Dennis dry-run', ?, ?, ?, ?)
    `).run(
      approvalId,
      taskId,
      JSON.stringify({ action: 'materialize_dry_run', task_id: taskId }),
      JSON.stringify({ source: 'dennis-agent', dennis_action: 'materialize_dry_run' }),
      now,
      now,
    );

    await service.handleWebhook({ message: { chat: { id: 123 }, from: { id: 123 }, text: `/approve ${approvalId}`, message_id: 1 } });

    expect(replies[0]).toContain('Approved and materialized Dennis dry\\-run');
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as any).status).toBe('approved');
    const event = db.prepare("SELECT * FROM execution_events WHERE task_id = ? AND event_type = 'dennis_approved_dry_run_materialized'").get(taskId) as any;
    expect(JSON.parse(event.tool_output).executed_mutations).toEqual([]);
  });
});
