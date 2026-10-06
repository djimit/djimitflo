/**
 * TelegramBotService — Telegram gateway for agent interaction.
 *
 * Enables users to interact with DjimFlo agents via Telegram:
 * - View loops (loop start/stop is not exposed here)
 * - Check agent status
 * - Approve/reject actions
 * - View mission control
 * - Receive alerts
 *
 * Based on OpenClaw's multi-channel architecture.
 */

import type { Database } from 'better-sqlite3';
import { DENNIS_AGENT_ID, DennisAgentService } from './dennis-agent-service';
import type { TelegramApiService } from './telegram-api-service';
import { mayApproveViaTelegram } from './telegram-identity';

interface TelegramConfig {
  botToken: string;
  allowedUsers: number[];
  webhookUrl?: string;
  userMap?: Record<string, string>;
}

interface TelegramMessage {
  chatId: number;
  text: string;
  userId: number;
  messageId: number;
  actorUserId: string;
}

export class TelegramBotService {
  private config: TelegramConfig | null = null;
  private baseUrl = 'https://api.telegram.org/bot';
  private linkedUsers = new Map<number, string>();

  constructor(private db: Database, private api?: TelegramApiService) {}

  /**
   * Configure the Telegram bot.
   */
  configure(config: TelegramConfig): void {
    this.config = config;
    this.linkedUsers.clear();
    for (const [telegramId, userRef] of Object.entries(config.userMap || {})) {
      const user = this.db.prepare('SELECT id FROM users WHERE id = ? OR email = ?').get(userRef, userRef) as { id: string } | undefined;
      if (user) this.linkedUsers.set(Number(telegramId), user.id);
    }
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
    callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number } } };
  }): Promise<void> {
    if (!this.config) return;
    if (payload.callback_query) { await this.handleCallback(payload.callback_query); return; }
    if (!payload.message) return;

    const { chat, from, text, message_id } = payload.message;
    if (!chat || !from || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(from.id) || typeof text !== 'string') return;

    // Check if user is allowed
    if (!this.config.allowedUsers.includes(from.id)) {
      await this.sendMessage(chat.id, '⛔ You are not authorized to use this bot.');
      return;
    }
    const actorUserId = this.linkedUsers.get(from.id);
    if (!actorUserId) {
      await this.sendMessage(chat.id, '⛔ Telegram identity is not linked to a DjimFlo user.');
      return;
    }
    const user = this.db.prepare('SELECT is_active FROM users WHERE id = ?').get(actorUserId) as { is_active: number } | undefined;
    if (!user?.is_active) {
      await this.sendMessage(chat.id, '⛔ DjimFlo account is disabled or no longer linked.');
      return;
    }

    const message: TelegramMessage = {
      chatId: chat.id,
      text: text.trim(),
      userId: from.id,
      messageId: message_id,
      actorUserId,
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
    const command = parts[0]?.toLowerCase().replace(/@[a-z0-9_]+$/, '');
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
        await this.createDennisDryRunTask(chatId, args.join(' '), message.actorUserId);
        break;

      case '/task':
      case '/cancel':
        try {
          if (!this.api) throw new Error('TELEGRAM_API_UNAVAILABLE');
          if (!args.length) { await this.sendMessage(chatId, `Usage: ${command} <${command === '/task' ? 'description' : 'task_id'}>`); break; }
          if (command === '/task') {
            const id = await this.api.createTask(args.join(' '), 'telegram-webhook', message.actorUserId);
            await this.sendMessage(chatId, `Task aangemaakt: ${id}`);
          } else {
            await this.api.cancelTask(args[0], message.actorUserId);
            await this.sendMessage(chatId, `Task geannuleerd: ${args[0]}`);
          }
        } catch (error) { await this.sendMessage(chatId, `Fout: ${error instanceof Error ? error.message : String(error)}`); }
        break;

      case '/approve':
        await this.handleApprove(chatId, args, message.actorUserId);
        break;

      case '/reject':
        await this.handleReject(chatId, args, message.actorUserId);
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
  async sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
    if (!this.config?.botToken) return;

    try {
      const response = await fetch(`${this.baseUrl}${this.config.botToken}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: this.escapeMarkdown(text),
          parse_mode: 'MarkdownV2',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });
      const result = await response.json() as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error('TELEGRAM_DELIVERY_FAILED');
    } catch {
      // Telegram's URL contains the bot credential; never propagate raw fetch errors.
      throw new Error('TELEGRAM_DELIVERY_FAILED');
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
   * UX-12: approval request with one-tap buttons. `text` is pre-built and redacted by operator-push (ids + aggregates).
   * The buttons only carry the approval id; the decision runs through the API as the mapped user (see handleCallback).
   */
  async requestApproval(approvalId: string, text: string, openUrl?: string | null): Promise<void> {
    if (!this.config) return;
    const keyboard = { inline_keyboard: [[
      { text: 'Approve', callback_data: `ap:${approvalId}` }, { text: 'Deny', callback_data: `dn:${approvalId}` },
      ...(openUrl ? [{ text: 'Open', url: openUrl }] : []),
    ]] };
    for (const userId of this.config.allowedUsers) {
      await this.sendMessage(userId, text, keyboard);
    }
  }

  /** Fixed deny reasons for the one-tap picker (callback_data stays under Telegram's 64-byte limit). */
  static readonly DENY_REASONS: Record<string, string> = { s: 'Out of scope', r: 'Too risky', w: 'Wrong change', l: 'Not now' };

  /**
   * UX-12 buttons. Only an allowlisted, active, D3-mapped user whose role holds approve:task may decide; the call goes
   * through the normal approval API as that user, so SELF_APPROVAL_FORBIDDEN and every other server rule still apply.
   */
  async handleCallback(q: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number } } }): Promise<string> {
    const chatId = q.message?.chat?.id ?? q.from?.id;
    const m = /^(ap|dn|rs):([A-Za-z0-9-]{1,64})(?::([srwl]))?$/.exec(q.data ?? '');
    if (!m || !Number.isSafeInteger(chatId)) return 'invalid';
    const actor = mayApproveViaTelegram(this.db, q.from?.id);
    if (!actor || !this.config?.allowedUsers.includes(q.from.id)) {
      await this.sendMessage(chatId, '⛔ Not allowed: this Telegram account is not mapped to a user who may approve.');
      return 'refused';
    }
    const [, kind, approvalId, reasonCode] = m;
    if (kind === 'dn') {
      await this.sendMessage(chatId, `Deny ${approvalId}: pick a reason`, { inline_keyboard: [Object.entries(TelegramBotService.DENY_REASONS)
        .map(([code, label]) => ({ text: label, callback_data: `rs:${approvalId}:${code}` }))] });
      return 'reason_asked';
    }
    try {
      if (!this.api) throw new Error('TELEGRAM_API_UNAVAILABLE');
      if (kind === 'ap') {
        await this.api.request(actor.userId, `/approvals/${encodeURIComponent(approvalId)}/approve`, 'POST');
        await this.sendMessage(chatId, `✅ Approved: ${approvalId}`);
        return 'approved';
      }
      const reason = TelegramBotService.DENY_REASONS[reasonCode ?? ''] ?? 'Denied via Telegram';
      await this.api.request(actor.userId, `/approvals/${encodeURIComponent(approvalId)}/deny`, 'POST', { reason });
      await this.sendMessage(chatId, `❌ Denied: ${approvalId} (${reason})`);
      return 'denied';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'APPROVAL_ALREADY_PROCESSED') {
        // TG-3: say who decided (ids/actor names only) instead of a bare error
        const row = this.db.prepare('SELECT status, approved_by, updated_at FROM approvals WHERE id = ?').get(approvalId) as { status: string; approved_by: string | null; updated_at: string | null } | undefined;
        const when = row?.updated_at ? ` at ${new Date(row.updated_at).toISOString().replace(/\.\d{3}Z$/, 'Z')}` : '';
        await this.sendMessage(chatId, `✅ Already ${row?.status ?? 'decided'} by ${row?.approved_by || 'a rule'}${when}`);
        return 'already_decided';
      }
      await this.sendMessage(chatId, message.startsWith('SELF_APPROVAL_FORBIDDEN') ? '⛔ You cannot approve your own request.' : `Error: ${message}`);
      return message.startsWith('SELF_APPROVAL_FORBIDDEN') ? 'self_approval' : 'error';
    }
  }

  // ─── Command Handlers ─────────────────────────────────────────────────

  private async sendWelcome(chatId: number): Promise<void> {
    await this.sendMessage(chatId,
      '🤖 *DjimFlo Bot*\n\n' +
      'Your agentic control plane\\. Use these commands:\n\n' +
      '/status \\- System health\n' +
      '/task \\<description\\> \\- Create a pending task, not execute it\n' +
      '/cancel \\<task_id\\> \\- Cancel a running owned task\n' +
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

  private async createDennisDryRunTask(chatId: number, prompt: string, actor: string): Promise<void> {
    const description = prompt.trim();
    if (!description) {
      await this.sendMessage(chatId, 'Usage: /dennis_task <beschrijving>');
      return;
    }
    try {
      if (!this.api) throw new Error('TELEGRAM_API_UNAVAILABLE');
      this.api.requireActor(actor, 'create:task');
      this.ensureDennisAgentRow(new Date().toISOString());
      const task = await this.api.request(actor, '/tasks', 'POST', {
        title: description.slice(0, 120), description, execution_mode: 'dry_run', risk_level: 'medium',
        agent_id: DENNIS_AGENT_ID, tags: ['telegram', 'dennis-agent', 'dry-run'], use_swarm_context: false, metadata: {
        source: 'telegram',
        autonomy_mode: 'dry_run_only',
        blocked_without_approval: ['external_write', 'destructive_action', 'production_mutation', 'external_message'],
        },
      });
      await this.sendMessage(chatId, `Dennis dry\\-run task aangemaakt: ${task.id}`);
    } catch (error) { await this.sendMessage(chatId, `Fout: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private ensureDennisAgentRow(now: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO agents (
        id, name, description, status, capabilities, created_at, updated_at, last_heartbeat_at
      ) VALUES (?, 'Dennis Agent', 'Safe-mode Dennis operator agent.', 'active', ?, ?, ?, ?)
    `).run(DENNIS_AGENT_ID, JSON.stringify(['telegram-bridge', 'paperclip-dry-run']), now, now, now);
  }

  private async handleApprove(chatId: number, args: string[], actorUserId: string): Promise<void> {
    const approvalId = args[0];
    if (!approvalId) {
      await this.sendMessage(chatId, 'Usage: /approve <approval_id>');
      return;
    }

    try {
      if (!this.api) throw new Error('TELEGRAM_API_UNAVAILABLE');
      await this.api.request(actorUserId, `/approvals/${encodeURIComponent(approvalId)}/approve`, 'POST');
      await this.sendMessage(chatId, `✅ Approved: ${approvalId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendMessage(chatId, message.startsWith('SELF_APPROVAL_FORBIDDEN')
        ? '⛔ Je kunt je eigen aanvraag niet goedkeuren.'
        : `Fout: ${message}`);
    }
  }

  private async handleReject(chatId: number, args: string[], actorUserId: string): Promise<void> {
    const approvalId = args[0];
    if (!approvalId) {
      await this.sendMessage(chatId, 'Usage: /reject <approval_id>');
      return;
    }

    try {
      if (!this.api) throw new Error('TELEGRAM_API_UNAVAILABLE');
      await this.api.request(actorUserId, `/approvals/${encodeURIComponent(approvalId)}/deny`, 'POST');
      await this.sendMessage(chatId, `❌ Rejected: ${approvalId}`);
    } catch (error) {
      await this.sendMessage(chatId, `Fout: ${error instanceof Error ? error.message : String(error)}`);
    }
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
