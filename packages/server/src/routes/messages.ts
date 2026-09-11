/**
 * Messages router — agent-to-agent communication via SQLite + WebSocket.
 */

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { messageBus, SwarmMessage } from '../services/message_bus';
import { WebSocketService } from '../services/websocket-service';
import type { AuthMiddleware } from '../middleware/auth';
import { WebSocketEventType } from '@djimitflo/shared';
import { randomUUID } from 'crypto';
import { boardMessageFingerprint, boardProtocolError, boardReplyTargetError } from '../services/board-protocol';

export function createMessageRoutes(
  db: Database,
  wsService?: WebSocketService,
  auth?: AuthMiddleware
): Router {
  const router = Router();
  // CodeQL js/missing-rate-limiting: every message handler performs DB access
  // and several also authorize or mutate durable agent state.
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const boundedLimit = (value: unknown): number => {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
    }
    return limit;
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_idempotency_keys (
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      message_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      store TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (sender, recipient, message_type, idempotency_key)
    )
  `);
  const hasMessagesTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
  const hasIdempotencyColumn = hasMessagesTable
    && Boolean(db.prepare('PRAGMA table_info(messages)').all().find((row: any) => row.name === 'idempotency_key'));
  if (hasIdempotencyColumn) {
    db.prepare(`
      INSERT OR IGNORE INTO board_idempotency_keys
        (sender, recipient, message_type, idempotency_key, store, message_id)
      SELECT from_agent_id, to_agent_id, type, idempotency_key, 'messages', id
      FROM messages WHERE idempotency_key IS NOT NULL
    `).run();
  }

  function parseMessage(row: any): SwarmMessage {
    return {
      id: row.id,
      from_agent_id: row.from_agent_id,
      to_agent_id: row.to_agent_id,
      type: row.type,
      payload: JSON.parse(row.payload || '{}'),
      priority: row.priority,
      read_at: row.read_at || null,
      created_at: row.created_at,
    };
  }

  function assertAgentPrincipal(req: any, agentId: string): void {
    // JWT sub identifies a user, not an agent. Only an explicit agent claim may
    // narrow an authenticated operator to a specific agent identity.
    const principal = req.user?.agent_id;
    if (principal && principal !== agentId) {
      throw createError(403, 'agent identity does not match authenticated principal', 'BOARD_AGENT_PRINCIPAL_INVALID');
    }
  }

  // POST /api/messages — Create a message
  router.post('/', requirePermission('create:task'), (req, res, next) => {
    try {
      const {
        from_agent_id,
        to_agent_id,
        type,
        payload,
        priority = 'low',
      } = req.body;
      const idempotencyKey = typeof req.body?.idempotency_key === 'string' && req.body.idempotency_key.trim()
        ? req.body.idempotency_key.trim()
        : (req.get('Idempotency-Key') || undefined);

      if (!from_agent_id || !to_agent_id || !type) {
        throw createError(400, 'from_agent_id, to_agent_id, and type are required', 'INVALID_INPUT');
      }
      assertAgentPrincipal(req, from_agent_id);

      const validTypes = ['task_delegation', 'status_update', 'knowledge_share', 'alert'];
      if (!validTypes.includes(type)) {
        throw createError(400, `Invalid type. Must be one of: ${validTypes.join(', ')}`, 'INVALID_INPUT');
      }

      const validPriorities = ['low', 'medium', 'high', 'urgent'];
      if (!validPriorities.includes(priority)) {
        throw createError(400, `Invalid priority. Must be one of: ${validPriorities.join(', ')}`, 'INVALID_INPUT');
      }

      const boardRole = payload && typeof payload === 'object'
        ? (payload as any).epistemic_role ?? (payload as any).epistemicRole
        : undefined;
      const boardEvidence = payload && typeof payload === 'object'
        ? (payload as any).evidence ?? (payload as any).evidence_refs ?? (payload as any).evidenceRefs
        : undefined;
      const boardThread = payload && typeof payload === 'object'
        ? (payload as any).thread_id ?? (payload as any).threadId
        : undefined;
      const boardReplyTo = payload && typeof payload === 'object'
        ? (payload as any).reply_to ?? (payload as any).replyTo
        : undefined;
      const protocolError = boardProtocolError(boardRole, boardEvidence, boardThread, boardReplyTo);
      if (protocolError) {
        throw createError(400, 'message rejected by board protocol', protocolError);
      }
      const replyError = boardReplyTargetError(db, boardReplyTo, boardThread, from_agent_id, to_agent_id);
      if (replyError) throw createError(400, 'message rejected by board protocol', replyError);

      // Validate agents exist
      const fromAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(from_agent_id);
      const toAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(to_agent_id);
      if (!fromAgent) {
        throw createError(400, 'from_agent_id does not exist', 'INVALID_INPUT');
      }
      if (!toAgent) {
        throw createError(400, 'to_agent_id does not exist', 'INVALID_INPUT');
      }

      if (idempotencyKey) {
        // Historical rows may overlap across stores. Only the reserved owner
        // can take the replay shortcut; all others use the transaction below.
        const existing = db.prepare(`
          SELECT * FROM messages
          WHERE from_agent_id = ? AND to_agent_id = ? AND type = ? AND idempotency_key = ?
            AND EXISTS (
              SELECT 1 FROM board_idempotency_keys AS owner
              WHERE owner.sender = messages.from_agent_id AND owner.recipient = messages.to_agent_id
                AND owner.message_type = messages.type AND owner.idempotency_key = messages.idempotency_key
                AND owner.store = 'messages' AND owner.message_id = messages.id
            )
        `).get(from_agent_id, to_agent_id, type, idempotencyKey);
        if (existing) {
          const existingPayload = JSON.parse((existing as any).payload || '{}');
          const requestedFingerprint = boardMessageFingerprint({ from: from_agent_id, to: to_agent_id, type, priority, payload: payload || {} });
          const existingFingerprint = boardMessageFingerprint({ from: from_agent_id, to: to_agent_id, type, priority: (existing as any).priority, payload: existingPayload });
          if (requestedFingerprint !== existingFingerprint) throw createError(409, 'idempotency key was reused with a different payload', 'BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
          res.status(200).json(parseMessage(existing));
          return;
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const payloadJson = JSON.stringify(payload || {});

      let replay: SwarmMessage | undefined;
      db.transaction(() => {
        if (idempotencyKey) {
          const reservation = db.prepare(`
            INSERT OR IGNORE INTO board_idempotency_keys
              (sender, recipient, message_type, idempotency_key, store, message_id)
            VALUES (?, ?, ?, ?, 'messages', ?)
          `).run(from_agent_id, to_agent_id, type, idempotencyKey, id);
          if (reservation.changes !== 1) {
            const owner = db.prepare(`
              SELECT store, message_id FROM board_idempotency_keys
              WHERE sender = ? AND recipient = ? AND message_type = ? AND idempotency_key = ?
            `).get(from_agent_id, to_agent_id, type, idempotencyKey) as { store?: string; message_id?: string } | undefined;
            if (owner?.store !== 'messages') throw new Error('BOARD_IDEMPOTENCY_SCOPE_CONFLICT');
            const existing = owner.message_id ? db.prepare('SELECT * FROM messages WHERE id = ?').get(owner.message_id) : undefined;
            if (existing) {
              const existingPayload = JSON.parse((existing as any).payload || '{}');
              const requestedFingerprint = boardMessageFingerprint({ from: from_agent_id, to: to_agent_id, type, priority, payload: payload || {} });
              const existingFingerprint = boardMessageFingerprint({ from: from_agent_id, to: to_agent_id, type, priority: (existing as any).priority, payload: existingPayload });
              if (requestedFingerprint !== existingFingerprint) throw new Error('BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
              replay = parseMessage(existing);
              return;
            }
            throw new Error('BOARD_IDEMPOTENCY_ORPHANED');
          }
        }
        db.prepare(`
          INSERT INTO messages (id, from_agent_id, to_agent_id, type, payload, priority, created_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, from_agent_id, to_agent_id, type, payloadJson, priority, now, idempotencyKey || null);
      })();
      if (replay) {
        res.status(200).json(replay);
        return;
      }

      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
      const message = parseMessage(row);

      messageBus.publish(to_agent_id, message).catch((err) => {
        console.error('[Messages] Message publish failed:', err instanceof Error ? err.message : String(err));
      });

      wsService?.broadcastToAuthenticated({
        type: WebSocketEventType.MESSAGE_SENT,
        payload: { message },
        timestamp: now,
      });

      res.status(201).json(message);
    } catch (error) {
      if (error instanceof Error && error.message === 'BOARD_IDEMPOTENCY_SCOPE_CONFLICT') {
        next(createError(409, 'idempotency key belongs to another board message store', error.message));
        return;
      }
      if (error instanceof Error && error.message === 'BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT') {
        next(createError(409, 'idempotency key was reused with a different payload', error.message));
        return;
      }
      next(error);
    }
  });

  // GET /api/messages/agent/:agent_id — Get messages for an agent
  router.get('/agent/:agent_id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { agent_id } = req.params;
      assertAgentPrincipal(req, agent_id);
      const { unread_only = 'false', limit = '50' } = req.query;

      const unreadOnly = unread_only === 'true';
      const maxLimit = boundedLimit(limit);

      let query = `
        SELECT * FROM messages
        WHERE from_agent_id = ? OR to_agent_id = ?
      `;
      const params: any[] = [agent_id, agent_id];

      if (unreadOnly) {
        query += ` AND read_at IS NULL`;
      }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(maxLimit);

      const rows = db.prepare(query).all(...params);
      const messages = rows.map((row: any) => parseMessage(row));

      res.json({ agent_id, messages, count: messages.length });
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/messages/:id/read — Mark a message as read
  router.patch('/:id/read', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const agentId = typeof req.body?.agent_id === 'string' ? req.body.agent_id.trim() : '';
      if (!agentId) throw createError(400, 'agent_id is required to mark a message read', 'BOARD_READ_AGENT_REQUIRED');
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
      if (!existing) throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      if (existing.to_agent_id !== agentId) throw createError(403, 'only the recipient can mark a message read', 'BOARD_READ_AGENT_INVALID');
      assertAgentPrincipal(req, agentId);
      const now = new Date().toISOString();

      const result = db.prepare(`
        UPDATE messages SET read_at = ? WHERE id = ? AND to_agent_id = ? AND read_at IS NULL
      `).run(now, id, agentId);

      if (result.changes === 0) {
        // Already read — return current state
        res.json(parseMessage(existing));
        return;
      }

      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      res.json(parseMessage(row));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/messages/:id — Get a single message by ID
  router.get('/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { id } = req.params;
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
      if (!row) {
        throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      }
      assertAgentPrincipal(req, row.to_agent_id);
      res.json(parseMessage(row));
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/messages/:id — Delete a message
  router.delete('/:id', requirePermission('delete:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const row = db.prepare('SELECT from_agent_id FROM messages WHERE id = ?').get(id) as { from_agent_id?: string } | undefined;
      if (!row) {
        throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      }
      assertAgentPrincipal(req, row.from_agent_id || '');
      const result = db.prepare('DELETE FROM messages WHERE id = ? AND from_agent_id = ?').run(id, row.from_agent_id);
      if (result.changes === 0) throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
