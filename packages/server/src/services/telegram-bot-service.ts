/**
 * TelegramBotService — Telegram gateway for agent interaction.
 *
 * Enables users to interact with DjimFlo agents via Telegram:
 * - Start/stop loops
 * - Check agent status
 * - Approve/reject actions
 * - View mission control
 * - Receive alerts
 *
 * Based on OpenClaw's multi-channel architecture.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { DENNIS_AGENT_ID, DennisAgentService } from './dennis-agent-service';

interface TelegramConfig {
  botToken: string;
  allowedUsers: number[];
  webhookUrl?: string;
}

interface TelegramMessage {
  chatId: number;
  text: string;
  userId: number;
  messageId: number;
}

export class TelegramBotService {
  private config: TelegramConfig | null = null;
  private baseUrl = 'https://api.telegram.org/bot';

  constructor(private db: Database) {}

  /**
   * Configure the Telegram bot.
   */
  configure(config: TelegramConfig): void {
    this.config = config;
  }

  /**
   * Check if the service is configured.
   */
  isConfigured(): boolean {
    return !!this.config?.botToken;
  }

  /**
   * Handle an incoming webhook message.
   */
  async handleWebhook(payload: {
    message?: {
      chat: { id: number };
      from: { id: number };
      text: string;
      message_id: number;
    };
  }): Promise<void> {
    if (!this.config || !payload.message) return;

    const { chat, from, text, message_id } = payload.message;

    // Check if user is allowed
    if (!this.config.allowedUsers.includes(from.id)) {
      await this.sendMessage(chat.id, '⛔ You are not authorized to use this bot.');
      return;
    }

    const message: TelegramMessage = {
      chatId: chat.id,
      text: text.trim(),
      userId: from.id,
      messageId: message_id,
    };

    await this.processCommand(message);
  }

  /**
   * Process a command from a Telegram user.
   */
  private async processCommand(message: TelegramMessage): Promise<void> {
    const { chatId, text } = message;

    // Parse command
    const parts = text.split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case '/start':
        await this.sendWelcome(chatId);
        break;

      case '/status':
        await this.sendStatus(chatId);
        break;

      case '/loops':
        await this.sendActiveLoops(chatId);
        break;

      case '/agents':
        await this.sendAgentStatus(chatId);
        break;

      case '/dennis':
        await this.sendDennisStatus(chatId);
        break;

      case '/dennis_task':
        await this.createDennisDryRunTask(chatId, args.join(' '));
        break;

      case '/approve':
        await this.handleApprove(chatId, args);
        break;

      case '/reject':
        await this.handleReject(chatId, args);
        break;

      case '/mission':
        await this.sendMissionControl(chatId);
        break;

      case '/help':
        await this.sendHelp(chatId);
        break;

      default:
        await this.sendMessage(chatId, `Unknown command: ${command}. Use /help for available commands.`);
    }
  }

  /**
   * Send a message to a Telegram chat.
   */
  async sendMessage(chatId: number, text: string): Promise<void> {
    if (!this.config?.botToken) return;

    try {
      await fetch(`${this.baseUrl}${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: this.escapeMarkdown(text),
          parse_mode: 'MarkdownV2',
        }),
      });
    } catch (error) {
      console.error('Telegram send error:', error);
    }
  }

  /**
   * Broadcast an alert to all allowed users.
   */
  async broadcastAlert(text: string): Promise<void> {
    if (!this.config) return;

    for (const userId of this.config.allowedUsers) {
      await this.sendMessage(userId, `🚨 Alert: ${text}`);
    }
  }

  /**
   * Send approval request to Telegram.
   */
  async requestApproval(approvalId: string, action: string, reason: string): Promise<void> {
    if (!this.config) return;

    const text = `⚠️ *Approval Required*\n\nAction: ${action}\nReason: ${reason}\n\nReply: \`/approve ${approvalId}\` or \`/reject ${approvalId}\``;

    for (const userId of this.config.allowedUsers) {
      await this.sendMessage(userId, text);
    }
  }

  // ─── Command Handlers ─────────────────────────────────────────────────

  private async sendWelcome(chatId: number): Promise<void> {
    await this.sendMessage(chatId,
      '🤖 *DjimFlo Bot*\n\n' +
      'Your agentic control plane\\. Use these commands:\n\n' +
      '/status \\- System health\n' +
      '/loops \\- Active loops\n' +
      '/agents \\- Agent status\n' +
      '/dennis \\- Dennis Agent status en scopes\n' +
      '/dennis\\_task \\<beschrijving\\> \\- Maak Dennis dry\\-run taak\n' +
      '/mission \\- Mission control\n' +
      '/approve \\<id\\> \\- Approve action\n' +
      '/reject \\<id\\> \\- Reject action\n' +
      '/help \\- This message'
    );
  }

  private async sendStatus(chatId: number): Promise<void> {
    const loops = this.db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE status IN ('running','verifying')").get() as any;
    const agents = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'active'").get() as any;
    const workers = this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'running'").get() as any;

    await this.sendMessage(chatId,
      `📊 *System Status*\n\n` +
      `Active loops: ${loops.c}\n` +
      `Active agents: ${agents.c}\n` +
      `Running workers: ${workers.c}`
    );
  }

  private async sendActiveLoops(chatId: number): Promise<void> {
    const loops = this.db.prepare("SELECT id, loop_name, status FROM loop_runs WHERE status IN ('running','verifying','blocked') ORDER BY created_at DESC LIMIT 5").all() as any[];

    if (loops.length === 0) {
      await this.sendMessage(chatId, 'No active loops.');
      return;
    }

    let text = '🔄 *Active Loops*\n\n';
    for (const loop of loops) {
      text += `• ${loop.loop_name} \\- ${loop.status}\n`;
    }

    await this.sendMessage(chatId, text);
  }

  private async sendAgentStatus(chatId: number): Promise<void> {
    const agents = this.db.prepare("SELECT name, status FROM agents ORDER BY updated_at DESC LIMIT 10").all() as any[];

    if (agents.length === 0) {
      await this.sendMessage(chatId, 'No agents registered.');
      return;
    }

    let text = '🤖 *Agent Status*\n\n';
    for (const agent of agents) {
      const icon = agent.status === 'active' ? '🟢' : agent.status === 'error' ? '🔴' : '⚪';
      text += `${icon} ${agent.name} \\- ${agent.status}\n`;
    }

    await this.sendMessage(chatId, text);
  }

  private async sendMissionControl(chatId: number): Promise<void> {
    const stats = {
      loops: (this.db.prepare("SELECT COUNT(*) as c FROM loop_runs").get() as any)?.c || 0,
      goals: (this.db.prepare("SELECT COUNT(*) as c FROM goals").get() as any)?.c || 0,
      agents: (this.db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0,
      leases: (this.db.prepare("SELECT COUNT(*) as c FROM worker_leases").get() as any)?.c || 0,
    };

    await this.sendMessage(chatId,
      `🎯 *Mission Control*\n\n` +
      `Total loops: ${stats.loops}\n` +
      `Total goals: ${stats.goals}\n` +
      `Total agents: ${stats.agents}\n` +
      `Total leases: ${stats.leases}`
    );
  }

  private async sendDennisStatus(chatId: number): Promise<void> {
    const snapshot = new DennisAgentService(this.db).readinessSnapshot();
    const signals = snapshot.self_context.ecosystem_contract.runtime_signals;
    const manifest = snapshot.self_context.access_manifest;
    await this.sendMessage(chatId,
      `🧭 *Dennis Agent*\n\n` +
      `Heartbeat: ${snapshot.heartbeat_fresh ? 'fresh' : 'stale'}\n` +
      `OKF: ${snapshot.knowledge_okf_valid ? 'valid' : 'blocked'}\n` +
      `Dry\\-run pending: ${snapshot.counts.dry_run_pending_tasks || 0}\n` +
      `Approval queue: ${snapshot.approval_queue.length}\n` +
      `Access: ${manifest.read_scopes.length} read scopes, ${manifest.allowed_actions.length} safe actions, ${manifest.approval_required_actions.length} gated actions\n` +
      `OpenClaw: ${signals.openclaw_state || 'unknown'}\n` +
      `Hermes CLI: ${signals.hermes_cli || 'unknown'}\n\n` +
      `Read: Djimitflo, OKF, memory refs, traces, OpenClaw state counts\n` +
      `Act: dry\\-run tasks; push/docker/production/external messages only after approval`
    );
  }

  private async createDennisDryRunTask(chatId: number, prompt: string): Promise<void> {
    const description = prompt.trim();
    if (!description) {
      await this.sendMessage(chatId, 'Usage: /dennis_task <beschrijving>');
      return;
    }
    const now = new Date().toISOString();
    const id = `telegram-${randomUUID()}`;
    this.ensureDennisAgentRow(now);
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, risk_level, execution_mode,
        agent_id, tags, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 'medium', 'medium', 'dry_run', ?, ?, ?, ?, ?)
    `).run(
      id,
      description.slice(0, 120) || 'Dennis Telegram task',
      description,
      DENNIS_AGENT_ID,
      JSON.stringify(['telegram', 'dennis-agent', 'dry-run']),
      JSON.stringify({
        source: 'telegram',
        autonomy_mode: 'dry_run_only',
        blocked_without_approval: ['external_write', 'destructive_action', 'production_mutation', 'external_message'],
      }),
      now,
      now,
    );
    await this.sendMessage(chatId, `Dennis dry\\-run task aangemaakt: ${id}`);
  }

  private ensureDennisAgentRow(now: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO agents (
        id, name, description, status, capabilities, created_at, updated_at, last_heartbeat_at
      ) VALUES (?, 'Dennis Agent', 'Safe-mode Dennis operator agent.', 'active', ?, ?, ?, ?)
    `).run(DENNIS_AGENT_ID, JSON.stringify(['telegram-bridge', 'paperclip-dry-run']), now, now, now);
  }

  private async handleApprove(chatId: number, args: string[]): Promise<void> {
    const approvalId = args[0];
    if (!approvalId) {
      await this.sendMessage(chatId, 'Usage: /approve <approval_id>');
      return;
    }

    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE approvals
      SET status = 'approved', approved_at = ?, approved_by = ?, decided_at = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, String(chatId), now, String(chatId), now, approvalId);
    const approval = this.db.prepare('SELECT id FROM approvals WHERE id = ?').get(approvalId);
    if (!approval) {
      await this.sendMessage(chatId, `Approval not found: ${approvalId}`);
      return;
    }
    const materialized = new DennisAgentService(this.db).materializeApprovedDryRun(approvalId, String(chatId));
    await this.sendMessage(chatId, materialized.status === 'materialized'
      ? `✅ Approved and materialized Dennis dry\\-run: ${approvalId}`
      : `✅ Approved: ${approvalId}${result.changes === 0 ? ' \\(already processed\\)' : ''}`);
  }

  private async handleReject(chatId: number, args: string[]): Promise<void> {
    const approvalId = args[0];
    if (!approvalId) {
      await this.sendMessage(chatId, 'Usage: /reject <approval_id>');
      return;
    }

    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE approvals
      SET status = 'denied', denied_at = ?, decided_at = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, now, String(chatId), now, approvalId);
    await this.sendMessage(chatId, result.changes > 0 ? `❌ Rejected: ${approvalId}` : `Approval not pending: ${approvalId}`);
  }

  private async sendHelp(chatId: number): Promise<void> {
    await this.sendWelcome(chatId);
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private escapeMarkdown(text: string): string {
    // Escape MarkdownV2 special characters
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }
}
