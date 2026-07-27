import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type http from 'http';
import { z } from 'zod';
import { startHttpServer } from '../transports/http.js';

describe('MCP Streamable HTTP transport', () => {
  let httpServer: http.Server | undefined;
  let client: Client | undefined;
  let secondClient: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await secondClient?.close();
    if (httpServer) {
      await new Promise<void>((resolve, reject) =>
        httpServer!.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it('supports an official client handshake and tool call', async () => {
    const createServer = () => {
      const server = new McpServer({ name: 'transport-test', version: '1.0.0' });
      server.registerTool('echo', { inputSchema: { value: z.string() } }, async ({ value }) => ({
        content: [{ type: 'text', text: value }],
      }));
      return server;
    };

    httpServer = await startHttpServer(createServer, 0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');

    client = new Client({ name: 'transport-test-client', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`)
      ));
    } catch (error) {
      throw new Error(`official client connection failed (${(error as { code?: number }).code}): ${String(error)}`);
    }

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
    expect(await client.callTool({ name: 'echo', arguments: { value: 'round-trip' } }))
      .toMatchObject({ content: [{ type: 'text', text: 'round-trip' }] });

    secondClient = new Client({ name: 'second-client', version: '1.0.0' });
    await secondClient.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`)
    ));
    expect((await secondClient.listTools()).tools.map((tool) => tool.name)).toContain('echo');
  });
});
