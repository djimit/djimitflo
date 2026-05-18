/**
 * MCP (Model Context Protocol) routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';

export function createMCPRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  
  // GET /api/mcp/servers - List all MCP servers
  router.get('/servers', (_req, res, next) => {
    try {
      const servers = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all();
      
      const parsed = servers.map((server: any) => ({
        ...server,
        args: JSON.parse(server.args || '[]'),
        env: JSON.parse(server.env || '{}'),
        metadata: JSON.parse(server.metadata || '{}'),
      }));
      
      res.json({ servers: parsed });
    } catch (error) {
      next(error);
    }
  });
  
  // GET /api/mcp/tools - List all MCP tools
  router.get('/tools', (req, res, next) => {
    try {
      const { server_id } = req.query;
      
      let query = 'SELECT * FROM mcp_tools';
      const params: any[] = [];
      
      if (server_id) {
        query += ' WHERE server_id = ?';
        params.push(server_id);
      }
      
      query += ' ORDER BY created_at DESC';
      
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

  router.get('/permissions', (_req, res, next) => {
    try {
      const permissions = db.prepare(`
        SELECT p.*, t.name as tool_name, t.server_id, t.description as tool_description
        FROM mcp_tool_permissions p
        JOIN mcp_tools t ON t.id = p.tool_id
        ORDER BY t.name ASC
      `).all();
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
