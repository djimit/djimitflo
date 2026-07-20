import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { AuthTokenPayload } from '@djimitflo/shared';
import { AuthorizationService } from '../services/authorization-service';
import type { AuthMiddleware } from '../middleware/auth';

function sanitizeMCPServer(server: any, isAdmin: boolean): any {
  if (isAdmin) return server;
  return {
    ...server,
    command: null,
    args: [],
    env: {},
    url: null,
  };
}

function metadata(server: any): Record<string, any> {
  try {
    return JSON.parse(server.metadata || '{}');
  } catch {
    return {};
  }
}

function probeSpec(server: any) {
  const meta = metadata(server);
  const url = String(meta.probe_url || new URL(String(meta.probe_path || ''), String(server.url)).toString());
  const accept = Array.isArray(meta.probe_accept_statuses)
    ? meta.probe_accept_statuses.map(Number)
    : [];
  return {
    url,
    accepts: (status: number) => (accept.length > 0 ? accept.includes(status) : status >= 200 && status < 400),
  };
}

function queryString(value: unknown): string {
  if (Array.isArray(value)) return queryString(value[0]);
  return typeof value === 'string' ? value : '';
}

export function createMCPRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  function getUser(req: any): AuthTokenPayload {
    return (req as any).user;
  }

  // GET /api/mcp/servers - List all MCP servers
  router.get('/servers', requireAuth, async (req, res, next) => {
    try {
      const user = getUser(req);
      const isAdmin = AuthorizationService.isAdmin(user);
      let servers = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all() as any[];
      if (req.query.refresh === 'true') {
        await Promise.all(servers.map(async (server) => {
          if (!server.url) return;
          const now = new Date().toISOString();
          const probe = probeSpec(server);
          try {
            const response = await fetch(probe.url, { signal: AbortSignal.timeout(1_500) });
            const running = probe.accepts(response.status);
            db.prepare('UPDATE mcp_servers SET status = ?, last_ping_at = ?, error_message = ?, updated_at = ? WHERE id = ?')
              .run(running ? 'running' : 'error', now, running ? null : `HTTP ${response.status} from ${probe.url}`, now, server.id);
          } catch (error) {
            db.prepare('UPDATE mcp_servers SET status = ?, last_ping_at = ?, error_message = ?, updated_at = ? WHERE id = ?')
              .run('error', now, error instanceof Error ? error.message : 'Health probe failed', now, server.id);
          }
        }));
        servers = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all() as any[];
      }

      const parsed = servers.map((server: any) => {
        const result = {
          ...server,
          args: JSON.parse(server.args || '[]'),
          env: JSON.parse(server.env || '{}'),
          metadata: JSON.parse(server.metadata || '{}'),
        };
        return sanitizeMCPServer(result, isAdmin);
      });

      res.json({ servers: parsed });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/mcp/tools - List all MCP tools
  router.get('/tools', requireAuth, requirePermission('read:repository'), (req, res, next) => {
    try {
      const serverId = queryString(req.query.server_id);
      const riskLevel = queryString(req.query.risk_level);
      const permission = queryString(req.query.permission);
      const q = queryString(req.query.q);

      let query = `
        SELECT t.*, s.name AS server_name, p.decision AS effective_decision
        FROM mcp_tools t
        LEFT JOIN mcp_servers s ON s.id = t.server_id
        LEFT JOIN mcp_tool_permissions p ON p.tool_id = t.id
      `;
      const params: any[] = [];
      const filters: string[] = [];

      if (serverId) {
        filters.push('t.server_id = ?');
        params.push(serverId);
      }
      if (riskLevel) {
        filters.push('t.risk_level = ?');
        params.push(riskLevel);
      }
      if (permission) {
        filters.push('t.permission = ?');
        params.push(permission);
      }
      if (q) {
        const term = `%${String(q)}%`;
        filters.push('(t.name LIKE ? OR t.description LIKE ? OR s.name LIKE ?)');
        params.push(term, term, term);
      }

      if (filters.length > 0) {
        query += ` WHERE ${filters.join(' AND ')}`;
      }

      query += ' ORDER BY t.created_at DESC';

      const tools = db.prepare(query).all(...params);

      const parsed = tools.map((tool: any) => ({
        ...tool,
        input_schema: JSON.parse(tool.input_schema || '{}'),
        metadata: JSON.parse(tool.metadata || '{}'),
      }));

      res.json({ tools: parsed });
    } catch (error) {
      next(error);
    }
  });

  router.get('/permissions', requireAuth, requirePermission('read:repository'), (req, res, next) => {
    try {
      const serverId = queryString(req.query.server_id);
      const riskLevel = queryString(req.query.risk_level);
      const decision = queryString(req.query.decision);
      const q = queryString(req.query.q);
      const params: any[] = [];
      const filters: string[] = [];
      if (serverId) {
        filters.push('t.server_id = ?');
        params.push(serverId);
      }
      if (riskLevel) {
        filters.push('p.risk_level = ?');
        params.push(riskLevel);
      }
      if (decision) {
        filters.push('p.decision = ?');
        params.push(decision);
      }
      if (q) {
        const term = `%${String(q)}%`;
        filters.push('(t.name LIKE ? OR t.description LIKE ? OR s.name LIKE ? OR p.reason LIKE ?)');
        params.push(term, term, term, term);
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
      const permissions = db.prepare(`
        SELECT p.*, t.name as tool_name, t.server_id, t.description as tool_description, s.name as server_name
        FROM mcp_tool_permissions p
        JOIN mcp_tools t ON t.id = p.tool_id
        LEFT JOIN mcp_servers s ON s.id = t.server_id
        ${where}
        ORDER BY t.name ASC
      `).all(...params);
      res.json({ permissions });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/permissions/:toolId', requirePermission('manage:config'), (req, res, next) => {
    try {
      const { toolId } = req.params;
      const tool = db.prepare('SELECT * FROM mcp_tools WHERE id = ?').get(toolId) as any;
      if (!tool) {
        res.status(404).json({ message: 'MCP tool not found' });
        return;
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO mcp_tool_permissions (id, tool_id, policy_id, decision, risk_level, reason, last_seen_at, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_id) DO UPDATE SET
          policy_id = excluded.policy_id,
          decision = excluded.decision,
          risk_level = excluded.risk_level,
          reason = excluded.reason,
          last_seen_at = excluded.last_seen_at,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        `mcp-perm-${toolId}`,
        toolId,
        req.body.policy_id || null,
        req.body.decision || tool.permission,
        req.body.risk_level || tool.risk_level,
        req.body.reason || null,
        now,
        JSON.stringify(req.body.metadata || {}),
        now,
        now
      );
      db.prepare('UPDATE mcp_tools SET permission = ?, risk_level = ?, updated_at = ? WHERE id = ?').run(
        req.body.decision || tool.permission,
        req.body.risk_level || tool.risk_level,
        now,
        toolId
      );
      const permission = db.prepare('SELECT * FROM mcp_tool_permissions WHERE tool_id = ?').get(toolId);
      res.json({ permission });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
