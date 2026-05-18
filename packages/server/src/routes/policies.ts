import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';

function parsePolicy(row: any) {
  const riskLevels = JSON.parse(row.risk_levels || '[]');
  return {
    ...row,
    risk_level: row.risk_level || riskLevels[0] || 'medium',
    enabled: Boolean(row.enabled),
    protected_paths: JSON.parse(row.protected_paths || '[]'),
    allowed_tools: JSON.parse(row.allowed_tools || '[]'),
    blocked_tools: JSON.parse(row.blocked_tools || '[]'),
    require_reason: Boolean(row.require_reason),
    risk_levels: riskLevels,
    tool_patterns: JSON.parse(row.tool_patterns || '[]'),
    file_patterns: JSON.parse(row.file_patterns || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

export function createPolicyRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  router.get('/', (_req, res, next) => {
    try {
      const policies = db.prepare('SELECT * FROM approval_policies ORDER BY priority DESC, created_at DESC').all();
      res.json({ policies: (policies as any[]).map(parsePolicy) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', (req, res, next) => {
    try {
      const policy = db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(req.params.id) as any;
      if (!policy) {
        throw createError(404, 'Policy not found', 'POLICY_NOT_FOUND');
      }
      res.json(parsePolicy(policy));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requirePermission('manage:config'), (req, res, next) => {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const input = req.body;
      db.prepare(`
        INSERT INTO approval_policies (
          id, name, description, enabled, priority, action_type, decision,
          risk_levels, tool_patterns, file_patterns, requires_approval, auto_approve,
          approval_timeout_ms, match_pattern, protected_paths, allowed_tools,
          blocked_tools, require_reason, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name,
        input.description || '',
        input.enabled === false ? 0 : 1,
        input.priority || 0,
        input.action_type || 'unknown',
        input.decision || 'require_approval',
        JSON.stringify(input.risk_levels || (input.risk_level ? [input.risk_level] : [])),
        JSON.stringify(input.tool_patterns || []),
        JSON.stringify(input.file_patterns || []),
        input.requires_approval === false ? 0 : 1,
        input.auto_approve ? 1 : 0,
        input.approval_timeout_ms || null,
        input.match_pattern || null,
        JSON.stringify(input.protected_paths || []),
        JSON.stringify(input.allowed_tools || []),
        JSON.stringify(input.blocked_tools || []),
        input.require_reason ? 1 : 0,
        JSON.stringify(input.metadata || {}),
        now,
        now
      );
      const created = db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(id) as any;
      res.status(201).json(parsePolicy(created));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', requirePermission('manage:config'), (req, res, next) => {
    try {
      const existing = db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(req.params.id) as any;
      if (!existing) {
        throw createError(404, 'Policy not found', 'POLICY_NOT_FOUND');
      }
      const input = req.body;
      db.prepare(`
        UPDATE approval_policies SET
          name = ?, description = ?, enabled = ?, priority = ?, action_type = ?, decision = ?,
          risk_levels = ?, tool_patterns = ?, file_patterns = ?, requires_approval = ?, auto_approve = ?,
          approval_timeout_ms = ?, match_pattern = ?, protected_paths = ?, allowed_tools = ?,
          blocked_tools = ?, require_reason = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name ?? existing.name,
        input.description ?? existing.description,
        input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0),
        input.priority ?? existing.priority,
        input.action_type ?? existing.action_type,
        input.decision ?? existing.decision,
        JSON.stringify(input.risk_levels ?? JSON.parse(existing.risk_levels || '[]')),
        JSON.stringify(input.tool_patterns ?? JSON.parse(existing.tool_patterns || '[]')),
        JSON.stringify(input.file_patterns ?? JSON.parse(existing.file_patterns || '[]')),
        input.requires_approval === undefined ? existing.requires_approval : (input.requires_approval ? 1 : 0),
        input.auto_approve === undefined ? existing.auto_approve : (input.auto_approve ? 1 : 0),
        input.approval_timeout_ms ?? existing.approval_timeout_ms,
        input.match_pattern ?? existing.match_pattern,
        JSON.stringify(input.protected_paths ?? JSON.parse(existing.protected_paths || '[]')),
        JSON.stringify(input.allowed_tools ?? JSON.parse(existing.allowed_tools || '[]')),
        JSON.stringify(input.blocked_tools ?? JSON.parse(existing.blocked_tools || '[]')),
        input.require_reason === undefined ? existing.require_reason : (input.require_reason ? 1 : 0),
        JSON.stringify(input.metadata ?? JSON.parse(existing.metadata || '{}')),
        new Date().toISOString(),
        req.params.id
      );
      const updated = db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(req.params.id) as any;
      res.json(parsePolicy(updated));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', requirePermission('manage:config'), (req, res, next) => {
    try {
      const result = db.prepare('DELETE FROM approval_policies WHERE id = ?').run(req.params.id);
      if (result.changes === 0) {
        throw createError(404, 'Policy not found', 'POLICY_NOT_FOUND');
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
