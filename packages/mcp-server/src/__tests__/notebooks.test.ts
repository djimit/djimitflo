import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const envKeys = ['NOTEBOOKLM_PYTHON', 'NOTEBOOKLM_BRIDGE_PATH'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const temporary: string[] = [];

function makeBridge(script: string): { python: string; bridge: string } {
  const dir = mkdtempSync(join(tmpdir(), 'djimitflo-notebooks-test-'));
  temporary.push(dir);
  const bridge = join(dir, 'bridge.sh');
  writeFileSync(bridge, script, { mode: 0o755 });
  return { python: '/bin/sh', bridge };
}

function echoArgsBridge(): { python: string; bridge: string } {
  return makeBridge(
    '#!/bin/sh\n' +
      "printf '{\"argv\":['\n" +
      'first=1\n' +
      'for arg in "$@"; do [ $first -eq 0 ] && printf ,; printf "\\"%s\\"" "$arg"; first=0; done\n' +
      "printf ']}'\n"
  );
}

function errorBridge(error: string, recovery?: string): { python: string; bridge: string } {
  const payload = recovery
    ? `{"error":"${error}","recovery":"${recovery}"}`
    : `{"error":"${error}"}`;
  return makeBridge(`#!/bin/sh\nprintf '%s' '${payload}'\n`);
}

function failingBridge(): { python: string; bridge: string } {
  return makeBridge('#!/bin/sh\necho "bridge exploded" >&2\nexit 3\n');
}

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function loadServer(python: string, bridge: string) {
  process.env.NOTEBOOKLM_PYTHON = python;
  process.env.NOTEBOOKLM_BRIDGE_PATH = bridge;
  const { registerNotebookTools } = await import('../tools/notebooks.js');
  const server = new McpServer({ name: 'notebook-unit', version: '0' });
  registerNotebookTools(server);
  return (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
}

describe('notebooks MCP tool contracts', () => {
  it('registers all NotebookLM tools', async () => {
    const { python, bridge } = echoArgsBridge();
    const tools = await loadServer(python, bridge);
    expect(Object.keys(tools).sort()).toEqual(
      [
        'notebook_list',
        'notebook_create',
        'notebook_delete',
        'notebook_add_source',
        'notebook_ask',
        'notebook_generate',
        'notebook_research',
        'notebook_notes',
        'notebook_download',
      ].sort()
    );
  });

  it('calls the bridge with the correct command and args for each tool', async () => {
    const { python, bridge } = echoArgsBridge();
    const tools = await loadServer(python, bridge);

    const cases: Array<{ name: string; input: object; expected: string[] }> = [
      { name: 'notebook_list', input: {}, expected: ['list'] },
      { name: 'notebook_create', input: { title: 'My Notebook' }, expected: ['create', 'My Notebook'] },
      { name: 'notebook_delete', input: { notebookId: 'nb-1' }, expected: ['delete', 'nb-1'] },
      { name: 'notebook_add_source', input: { notebookId: 'nb-1', type: 'url', value: 'https://x' }, expected: ['add_url', 'nb-1', 'https://x'] },
      { name: 'notebook_add_source', input: { notebookId: 'nb-1', type: 'text', value: 'body', title: 'T' }, expected: ['add_text', 'nb-1', 'T', 'body'] },
      { name: 'notebook_add_source', input: { notebookId: 'nb-1', type: 'text', value: 'body' }, expected: ['add_text', 'nb-1', 'Untitled', 'body'] },
      { name: 'notebook_add_source', input: { notebookId: 'nb-1', type: 'file', value: '/p/f.txt' }, expected: ['add_file', 'nb-1', '/p/f.txt'] },
      { name: 'notebook_ask', input: { notebookId: 'nb-1', question: 'why?' }, expected: ['ask', 'nb-1', 'why?'] },
      { name: 'notebook_generate', input: { notebookId: 'nb-1', artifactType: 'audio' }, expected: ['generate_audio', 'nb-1'] },
      { name: 'notebook_research', input: { notebookId: 'nb-1', query: 'topic' }, expected: ['research_start', 'nb-1', 'topic'] },
      { name: 'notebook_notes', input: { notebookId: 'nb-1', action: 'list' }, expected: ['notes_list', 'nb-1'] },
      { name: 'notebook_notes', input: { notebookId: 'nb-1', action: 'create', title: 'N', content: 'C' }, expected: ['note_create', 'nb-1', 'N', 'C'] },
      { name: 'notebook_notes', input: { notebookId: 'nb-1', action: 'create' }, expected: ['note_create', 'nb-1', 'Untitled', ''] },
      { name: 'notebook_download', input: { notebookId: 'nb-1', artifactType: 'quiz', outputPath: '/o/q' }, expected: ['download_quiz', 'nb-1', '/o/q'] },
    ];

    for (const { name, input, expected } of cases) {
      const result = await tools[name].handler(input);
      expect(result.isError, `${name} should not error`).not.toBe(true);
      const argv: string[] = JSON.parse(result.content[0].text).argv;
      expect(argv, `${name} bridge argv`).toEqual(expected);
    }
  });

  it('returns an error payload when the bridge reports an error object', async () => {
    const { python, bridge } = errorBridge('auth expired', 'rotate token');
    const tools = await loadServer(python, bridge);
    const result = await tools.notebook_list.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NotebookLM Error: auth expired');
    expect(result.content[0].text).toContain('Recovery: rotate token');
  });

  it('returns a plain error message when no recovery hint is present', async () => {
    const { python, bridge } = errorBridge('not found');
    const tools = await loadServer(python, bridge);
    const result = await tools.notebook_create.handler({ title: 'X' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('NotebookLM Error: not found');
    expect(result.content[0].text).not.toContain('Recovery');
  });

  it('surfaces subprocess failures as error text', async () => {
    const { python, bridge } = failingBridge();
    const tools = await loadServer(python, bridge);
    const result = await tools.notebook_delete.handler({ notebookId: 'n' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error:');
  });
});