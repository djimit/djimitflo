import type { Database } from 'better-sqlite3';
import { boardProtocolError, boardReplyTargetError } from './board-protocol';
import { BOARD_HANDOFF_AUTHORITY, WorkItemService } from './work-item-service';

export interface BoardHandoffResult {
  scanned: number;
  candidates: number;
  created: number;
  existing: number;
  rejected: number;
  status: 'PASS' | 'DEGRADED';
  blocked_reasons: string[];
}

export interface BoardHandoffPublishResult {
  attempted: number;
  published: number;
  failed: number;
  status: 'PASS' | 'DISABLED' | 'DEGRADED';
}

/** Converts only explicit, evidence-linked board proposals/outcomes into review work. */
export class BoardHandoffService {
  private readonly workItems: WorkItemService;

  constructor(private readonly db: Database) {
    this.workItems = new WorkItemService(db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_handoff_claims (
        source_ref TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('processing', 'created', 'rejected')),
        work_item_id TEXT,
        reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_handoff_outbox (
        source_ref TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'failed')) DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        published_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_board_handoff_outbox_status ON board_handoff_outbox(status, created_at);
    `);
  }

  reconcile(limit = 100): BoardHandoffResult {
    const result: BoardHandoffResult = {
      scanned: 0, candidates: 0, created: 0, existing: 0, rejected: 0,
      status: 'PASS', blocked_reasons: [],
    };
    if (!this.hasTable('agent_messages') && !this.hasTable('messages')) {
      return { ...result, status: 'DEGRADED', blocked_reasons: ['BOARD_MESSAGES_UNAVAILABLE'] };
    }
    if (!this.hasTable('work_items')) {
      return { ...result, status: 'DEGRADED', blocked_reasons: ['BOARD_WORK_ITEMS_UNAVAILABLE'] };
    }

    const max = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows: Array<Record<string, unknown>> = [];
    if (this.hasTable('agent_messages')) rows.push(...this.db.prepare(`
      SELECT id, from_agent, to_agent, type, payload_json, timestamp, 'agent_messages' AS board_source
      FROM agent_messages
      LEFT JOIN board_handoff_claims c ON c.source_ref = 'agent_messages:' || agent_messages.id
      WHERE c.source_ref IS NULL OR (c.status = 'processing' AND c.updated_at < datetime('now', '-5 minutes'))
      ORDER BY timestamp ASC, id ASC LIMIT ?
    `).all(max) as Array<Record<string, unknown>>);
    if (this.hasTable('messages')) rows.push(...this.db.prepare(`
      SELECT id, from_agent_id AS from_agent, to_agent_id AS to_agent, type, payload AS payload_json, created_at AS timestamp, 'messages' AS board_source
      FROM messages
      LEFT JOIN board_handoff_claims c ON c.source_ref = 'messages:' || messages.id
      WHERE c.source_ref IS NULL OR (c.status = 'processing' AND c.updated_at < datetime('now', '-5 minutes'))
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(max) as Array<Record<string, unknown>>);
    rows.sort((left, right) => `${left.timestamp}:${left.id}`.localeCompare(`${right.timestamp}:${right.id}`));
    rows.splice(max);
    for (const row of rows) {
      result.scanned += 1;
      const payload = this.object(row.payload_json);
      const role = payload?.epistemic_role ?? payload?.epistemicRole;
      if (role !== 'proposal' && role !== 'outcome') continue;
      result.candidates += 1;
      const evidence = payload?.evidence ?? payload?.evidence_refs ?? payload?.evidenceRefs;
      const protocolError = boardProtocolError(role, evidence, payload?.thread_id ?? payload?.threadId, payload?.reply_to ?? payload?.replyTo);
      const evidenceRefs = this.strings(evidence);
      const handoffError = protocolError || boardReplyTargetError(this.db, payload.reply_to ?? payload.replyTo, payload.thread_id ?? payload.threadId, row.from_agent, row.to_agent)
        || (!evidenceRefs.length ? 'BOARD_ACTION_EVIDENCE_REQUIRED' : null);
      if (handoffError) {
        result.rejected += 1;
        result.status = 'DEGRADED';
        this.db.prepare(`INSERT OR IGNORE INTO board_handoff_claims (source_ref, status, reason) VALUES (?, 'rejected', ?)`)
          .run(this.sourceRef(row), handoffError);
        if (!result.blocked_reasons.includes(handoffError)) result.blocked_reasons.push(handoffError);
        continue;
      }

      const messageId = String(row.id);
      const action = this.string(payload?.action) || `${role} from ${String(row.from_agent)}`;
      const risk = this.risk(payload?.risk_class);
      if (!risk) {
        result.rejected += 1;
        result.status = 'DEGRADED';
        this.db.prepare(`INSERT OR IGNORE INTO board_handoff_claims (source_ref, status, reason) VALUES (?, 'rejected', 'BOARD_RISK_CLASS_INVALID')`)
          .run(this.sourceRef(row));
        if (!result.blocked_reasons.includes('BOARD_RISK_CLASS_INVALID')) result.blocked_reasons.push('BOARD_RISK_CLASS_INVALID');
        continue;
      }
      const handoff = this.db.transaction(() => {
        const claim = this.db.prepare(`INSERT OR IGNORE INTO board_handoff_claims (source_ref, status) VALUES (?, 'processing')`)
          .run(this.sourceRef(row));
        if (claim.changes !== 1) {
          const reclaimed = this.db.prepare(`
            UPDATE board_handoff_claims SET status = 'processing', reason = NULL, updated_at = datetime('now')
            WHERE source_ref = ? AND status = 'processing' AND updated_at < datetime('now', '-5 minutes')
          `).run(this.sourceRef(row));
          if (reclaimed.changes !== 1) return null;
        }
        const created = this.workItems.createIfMissingBySourceRef({
          title: `Board ${role}: ${action}`,
          description: `Evidence-linked ${role} from ${String(row.from_agent)} to ${String(row.to_agent)}. Action: ${action}. Evidence: ${evidenceRefs.join(', ')}`,
          source: 'agent_board',
          source_ref: this.sourceRef(row),
          risk_class: risk,
          confidence: this.confidence(payload?.confidence),
          value_score: this.score(payload?.value_score),
          status: 'blocked',
          recommended_loop: 'agent-board-review-loop',
          metadata: {
            approval_state: 'REVIEW_REQUIRED',
            requires_human_approval: true,
            board_message_id: messageId,
            board_source: row.board_source,
            thread_id: this.string(payload?.thread_id ?? payload?.threadId),
            reply_to: this.string(payload?.reply_to ?? payload?.replyTo),
            epistemic_role: role,
            evidence_refs: evidenceRefs,
            occurred_at: row.timestamp,
            downstream_targets: ['EVE-V', 'Paperclip', 'content-publication', 'revenue-leads'],
          },
        }, BOARD_HANDOFF_AUTHORITY);
        this.db.prepare(`UPDATE board_handoff_claims SET status = 'created', work_item_id = ?, updated_at = datetime('now') WHERE source_ref = ?`)
          .run(created.work_item.id, this.sourceRef(row));
        const eventId = `board-handoff:${this.sourceRef(row)}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO board_handoff_outbox (source_ref, event_id, payload)
          VALUES (?, ?, ?)
        `).run(this.sourceRef(row), eventId, JSON.stringify({
          event_id: eventId,
          event_type: 'agent.board.handoff.created',
          source: 'djimitflo-board',
          correlation_id: this.sourceRef(row),
          causation_id: messageId,
          aggregate_id: created.work_item.id,
          aggregate_version: 1,
          dedupe_key: `board-handoff:${this.sourceRef(row)}`,
          occurred_at: new Date().toISOString(),
          approval_state: 'REVIEW_REQUIRED',
          requires_human_approval: true,
          work_item_id: created.work_item.id,
          downstream_targets: ['EVE-V', 'Paperclip', 'content-publication', 'revenue-leads'],
          evidence_refs: evidenceRefs,
          thread_id: this.string(payload?.thread_id ?? payload?.threadId),
          epistemic_role: role,
        }));
        return created;
      })();
      if (!handoff) {
        result.existing += 1;
        continue;
      }
      if (handoff.created) result.created += 1;
      else result.existing += 1;
    }
    return result;
  }

  async publishPending(limit = 100): Promise<BoardHandoffPublishResult> {
    const busUrl = process.env.DJIMIT_EVENT_BUS_URL?.replace(/\/$/, '');
    if (!busUrl) return { attempted: 0, published: 0, failed: 0, status: 'DISABLED' };
    const max = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = this.db.prepare(`
      SELECT source_ref, payload, attempts
      FROM board_handoff_outbox
      WHERE status IN ('pending', 'failed') AND attempts < 10
      ORDER BY created_at ASC LIMIT ?
    `).all(max) as Array<{ source_ref: string; payload: string; attempts: number }>;
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      this.db.prepare('UPDATE board_handoff_outbox SET attempts = attempts + 1 WHERE source_ref = ?').run(row.source_ref);
      try {
        const response = await fetch(`${busUrl}/events/${encodeURIComponent(process.env.DJIMIT_EVENT_STREAM || 'djimit.events')}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: row.payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`EVENT_BUS_HTTP_${response.status}`);
        this.db.prepare("UPDATE board_handoff_outbox SET status = 'published', published_at = datetime('now'), last_error = NULL WHERE source_ref = ?").run(row.source_ref);
        published += 1;
      } catch (error) {
        failed += 1;
        this.db.prepare("UPDATE board_handoff_outbox SET status = 'failed', last_error = ? WHERE source_ref = ?").run(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), row.source_ref);
      }
    }
    return { attempted: rows.length, published, failed, status: failed ? 'DEGRADED' : 'PASS' };
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  private object(value: unknown): Record<string, unknown> {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
  }

  private confidence(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0.5;
  }

  private score(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : 50;
  }

  private sourceRef(row: Record<string, unknown>): string {
    return `${String(row.board_source)}:${String(row.id)}`;
  }

  private risk(value: unknown): 'low' | 'medium' | 'high' | 'critical' | null {
    if (value === undefined || value === null || value === '') return 'medium';
    return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : null;
  }

}
