/**
 * NotebookLM MCP tools.
 * Exposes: notebook_list, notebook_create, notebook_delete, notebook_add_source,
 *          notebook_ask, notebook_generate, notebook_research, notebook_notes
 *
 * These tools call bridge.py on the workstation via subprocess.
 * The bridge uses keepalive auth rotation with NOTEBOOKLM_REFRESH_CMD fallback.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BRIDGE_PATH = process.env.NOTEBOOKLM_BRIDGE_PATH
  || process.env.HOME + '/workspace/notebooklm-mcp/bridge.py';
const PYTHON_BIN = process.env.NOTEBOOKLM_PYTHON || process.env.HOME + '/.venvs/notebooklm/bin/python3';

async function callBridge(command: string, args: string[] = []): Promise<unknown> {
  const { stdout } = await execFileAsync(PYTHON_BIN, [BRIDGE_PATH, command, ...args], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function bridgeError(result: unknown): string {
  if (result && typeof result === 'object' && 'error' in result) {
    const err = result as { error: string; recovery?: string };
    return err.recovery
      ? `NotebookLM Error: ${err.error}\nRecovery: ${err.recovery}`
      : `NotebookLM Error: ${err.error}`;
  }
  return 'Unknown NotebookLM error';
}

export function registerNotebookTools(server: McpServer) {
  server.registerTool(
    'notebook_list',
    { description: 'List all NotebookLM notebooks with metadata', inputSchema: {} },
    async () => {
      try {
        const result = await callBridge('list');
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_create',
    { description: 'Create a new NotebookLM notebook', inputSchema: { title: z.string().describe('Notebook title') } },
    async ({ title }) => {
      try {
        const result = await callBridge('create', [title]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_delete',
    { description: 'Delete a NotebookLM notebook', inputSchema: { notebookId: z.string().describe('The notebook ID') } },
    async ({ notebookId }) => {
      try {
        const result = await callBridge('delete', [notebookId]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_add_source',
    { description: 'Add a source (URL, text, or file) to a notebook', inputSchema: { notebookId: z.string().describe('The notebook ID'), type: z.enum(['url', 'text', 'file']).describe('Source type'), value: z.string().describe('URL, text content, or file path'), title: z.string().optional().describe('Title for text sources') } },
    async ({ notebookId, type, value, title }) => {
      try {
        let result: unknown;
        if (type === 'url') result = await callBridge('add_url', [notebookId, value]);
        else if (type === 'text') result = await callBridge('add_text', [notebookId, title || 'Untitled', value]);
        else result = await callBridge('add_file', [notebookId, value]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_ask',
    { description: 'Ask a question grounded in the notebook sources. Returns answer with citations.', inputSchema: { notebookId: z.string().describe('The notebook ID'), question: z.string().describe('The question to ask') } },
    async ({ notebookId, question }) => {
      try {
        const result = await callBridge('ask', [notebookId, question]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_generate',
    { description: 'Generate an artifact (audio, report, quiz, mindmap, slides, infographic, video)', inputSchema: { notebookId: z.string().describe('The notebook ID'), artifactType: z.enum(['audio', 'report', 'quiz', 'flashcards', 'mindmap', 'slides', 'infographic', 'video']).describe('Type of artifact to generate') } },
    async ({ notebookId, artifactType }) => {
      try {
        const result = await callBridge('generate_' + artifactType, [notebookId]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_research',
    { description: 'Start a web research session and import sources into the notebook', inputSchema: { notebookId: z.string().describe('The notebook ID'), query: z.string().describe('Research query') } },
    async ({ notebookId, query }) => {
      try {
        const result = await callBridge('research_start', [notebookId, query]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_notes',
    { description: 'List or create notes in a notebook', inputSchema: { notebookId: z.string().describe('The notebook ID'), action: z.enum(['list', 'create']).describe('Action to perform'), title: z.string().optional().describe('Note title (for create)'), content: z.string().optional().describe('Note content (for create)') } },
    async ({ notebookId, action, title, content }) => {
      try {
        let result: unknown;
        if (action === 'list') result = await callBridge('notes_list', [notebookId]);
        else result = await callBridge('note_create', [notebookId, title || 'Untitled', content || '']);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );

  server.registerTool(
    'notebook_download',
    { description: 'Download a generated artifact (audio, report, quiz)', inputSchema: { notebookId: z.string().describe('The notebook ID'), artifactType: z.enum(['audio', 'report', 'quiz']).describe('Type of artifact to download'), outputPath: z.string().describe('Output file path') } },
    async ({ notebookId, artifactType, outputPath }) => {
      try {
        const result = await callBridge('download_' + artifactType, [notebookId, outputPath]);
        if ('error' in (result as object)) return { content: [{ type: 'text' as const, text: bridgeError(result) }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    }
  );
}
