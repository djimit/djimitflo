/**
 * HTTP (Streamable HTTP) transport for DjimFlo MCP Server.
 * Serves MCP endpoints at /mcp for remote fleet access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import http from 'http';

export async function startHttpServer(server: McpServer, port: number): Promise<void> {
  const transports: Map<string, SSEServerTransport> = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/mcp' && req.method === 'GET') {
      const transport = new SSEServerTransport('/mcp', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => { transports.delete(transport.sessionId); });
      await server.connect(transport);
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404).end('Session not found');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', name: 'djimflo-mcp' }));
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '0.0.0.0', resolve);
  });
}
