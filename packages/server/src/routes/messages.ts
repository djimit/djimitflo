/**
 * Messages router — agent-to-agent communication via SQLite + WebSocket.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { messageBus, SwarmMessage } from '../services/message_bus';
import { WebSocketService } from '../services/websocket-service';
import type { AuthMiddleware } from '../middleware/auth';
import { WebSocketEventType } from '@djimitflo/shared';
import { randomUUID } from 'crypto';

export function createMessageRoutes(
  db: Database,
  wsService?: WebSocketService,
  auth?: AuthMiddleware
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

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

      if (!from_agent_id || !to_agent_id || !type) {
        throw createError(400, 'from_agent_id, to_agent_id, and type are required', 'INVALID_INPUT');
      }

      const validTypes = ['task_delegation', 'status_update', 'knowledge_share', 'alert'];
      if (!validTypes.includes(type)) {
        throw createError(400, `Invalid type. Must be one of: ${validTypes.join(', ')}`, 'INVALID_INPUT');
      }

      const validPriorities = ['low', 'medium', 'high', 'urgent'];
      if (!validPriorities.includes(priority)) {
        throw createError(400, `Invalid priority. Must be one of: ${validPriorities.join(', ')}`, 'INVALID_INPUT');
      }

      // Validate agents exist
      const fromAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(from_agent_id);
      const toAgent = db.prepare('SELECT id FROM agents WHERE id = ?').get(to_agent_id);
      if (!fromAgent) {
        throw createError(400, 'from_agent_id does not exist', 'INVALID_INPUT');
      }
      if (!toAgent) {
        throw createError(400, 'to_agent_id does not exist', 'INVALID_INPUT');
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const payloadJson = JSON.stringify(payload || {});

      db.prepare(`
        INSERT INTO messages (id, from_agent_id, to_agent_id, type, payload, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, from_agent_id, to_agent_id, type, payloadJson, priority, now);

      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
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
      next(error);
    }
  });

  // GET /api/messages/agent/:agent_id — Get messages for an agent
  router.get('/agent/:agent_id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { agent_id } = req.params;
      const { unread_only = 'false', limit = '50' } = req.query;

      const unreadOnly = unread_only === 'true';
      const maxLimit = Math.min(Number(limit) || 50, 500);

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
      const now = new Date().toISOString();

      const result = db.prepare(`
        UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL
      `).run(now, id);

      if (result.changes === 0) {
        const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        if (!existing) {
          throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
        }
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
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!row) {
        throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      }
      res.json(parseMessage(row));
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/messages/:id — Delete a message
  router.delete('/:id', requirePermission('delete:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
      if (result.changes === 0) {
        throw createError(404, 'Message not found', 'MESSAGE_NOT_FOUND');
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
