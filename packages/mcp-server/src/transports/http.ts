/**
 * HTTP (Streamable HTTP) transport for DjimFlo MCP Server.
 * Serves MCP endpoints at /mcp for remote fleet access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import http from 'http';

export async function startHttpServer(createServer: () => McpServer, port: number): Promise<http.Server> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/mcp' && ['GET', 'POST', 'DELETE'].includes(req.method || '')) {
      const sessionId = req.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
      if (!transport && req.method === 'POST' && !sessionId) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => { transports.set(id, transport!); },
          onsessionclosed: (id) => { transports.delete(id); },
        });
        transport.onerror = (error) => {
          console.error('DjimFlo MCP HTTP transport error:', error);
        };
        await createServer().connect(transport);
      }
      if (!transport) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      await transport.handleRequest(req, res);
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
  return httpServer;
}
