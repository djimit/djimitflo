/**
 * MCP (Model Context Protocol) routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';

export function createMCPRoutes(db: Database): Router {
  const router = Router();
  
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
  
  return router;
}
