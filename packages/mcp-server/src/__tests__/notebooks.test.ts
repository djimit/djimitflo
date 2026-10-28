import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNotebookTools } from '../tools/notebooks.js';

type ExecCall = { cmd: string; bridgeArgs: string[]; opts: unknown };
let execCalls: ExecCall[] = [];
let nextStdout: string | null = null;
let nextError: Error | null = null;

// notebooks.ts does `const { stdout } = await execFileAsync(...)`. Node's execFile carries a
// util.promisify.custom symbol so the promise resolves to { stdout, stderr }; a plain mock
// resolves to the first callback arg instead. We collapse the result into one object so the
// default promisify behaviour yields the shape the production code destructures.
type Cb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function execFileMock(...args: unknown[]): void {
  const inner = args[1] as string[];
  const opts = args[2];
  const cb = args[args.length - 1] as Cb;
  execCalls.push({ cmd: inner[0], bridgeArgs: inner.slice(1), opts });
  if (nextError) process.nextTick(() => cb(nextError, { stdout: '', stderr: '' }));
  else process.nextTick(() => cb(null, { stdout: nextStdout ?? '{}', stderr: '' }));
}

vi.mock('child_process', () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

type ToolBox = Record<
  string,
  { handler: (input?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
>;

function toolsOf(server: McpServer): ToolBox {
  return (server as unknown as { _registeredTools: ToolBox })._registeredTools;
}

const bridgeArgs = () => execCalls.map((c) => c.bridgeArgs);

describe('NotebookLM MCP tools (registerNotebookTools)', () => {
  let server: McpServer;
  let tools: ToolBox;

  beforeEach(() => {
    execCalls = [];
    nextStdout = null;
    nextError = null;
    server = new McpServer({ name: 'notebooks-test', version: '0' });
    registerNotebookTools(server);
    tools = toolsOf(server);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('registers all nine NotebookLM tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'notebook_add_source', 'notebook_ask', 'notebook_create', 'notebook_delete',
      'notebook_download', 'notebook_generate', 'notebook_list', 'notebook_notes',
      'notebook_research',
    ]);
  });

  it('notebook_list serializes bridge stdout and calls list', async () => {
    nextStdout = JSON.stringify({ notebooks: [{ id: 'nb1', title: 'Research' }] });
    const result = await tools.notebook_list.handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ notebooks: [{ id: 'nb1', title: 'Research' }] });
    expect(bridgeArgs()[0]).toEqual(['list']);
  });

  it('notebook_create forwards the title to the create command', async () => {
    nextStdout = JSON.stringify({ id: 'nb2', title: 'New' });
    const result = await tools.notebook_create.handler({ title: 'New' });
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'nb2', title: 'New' });
    expect(bridgeArgs()[0]).toEqual(['create', 'New']);
  });

  it('notebook_delete forwards the notebookId', async () => {
    nextStdout = JSON.stringify({ deleted: true });
    const result = await tools.notebook_delete.handler({ notebookId: 'nb3' });
    expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true });
    expect(bridgeArgs()[0]).toEqual(['delete', 'nb3']);
  });

  it('notebook_add_source routes url/text/file to the correct bridge command', async () => {
    nextStdout = JSON.stringify({ ok: true });
    await tools.notebook_add_source.handler({ notebookId: 'nb', type: 'url', value: 'https://x' });
    await tools.notebook_add_source.handler({ notebookId: 'nb', type: 'text', value: 'hi', title: 'T' });
    await tools.notebook_add_source.handler({ notebookId: 'nb', type: 'file', value: '/p/f.txt' });
    expect(bridgeArgs()).toEqual([
      ['add_url', 'nb', 'https://x'],
      ['add_text', 'nb', 'T', 'hi'],
      ['add_file', 'nb', '/p/f.txt'],
    ]);
  });

  it('notebook_add_source defaults the text title to Untitled', async () => {
    nextStdout = JSON.stringify({ ok: true });
    await tools.notebook_add_source.handler({ notebookId: 'nb', type: 'text', value: 'hi' });
    expect(bridgeArgs()[0]).toEqual(['add_text', 'nb', 'Untitled', 'hi']);
  });

  it('notebook_ask forwards notebookId and question', async () => {
    nextStdout = JSON.stringify({ answer: '42', citations: [] });
    const result = await tools.notebook_ask.handler({ notebookId: 'nb', question: 'why?' });
    expect(JSON.parse(result.content[0].text)).toEqual({ answer: '42', citations: [] });
    expect(bridgeArgs()[0]).toEqual(['ask', 'nb', 'why?']);
  });

  it('notebook_generate prefixes the artifact type with generate_', async () => {
    nextStdout = JSON.stringify({ url: 'https://audio' });
    await tools.notebook_generate.handler({ notebookId: 'nb', artifactType: 'audio' });
    await tools.notebook_generate.handler({ notebookId: 'nb', artifactType: 'flashcards' });
    expect(bridgeArgs()).toEqual([['generate_audio', 'nb'], ['generate_flashcards', 'nb']]);
  });

  it('notebook_research calls research_start', async () => {
    nextStdout = JSON.stringify({ session: 's1' });
    const result = await tools.notebook_research.handler({ notebookId: 'nb', query: 'topic' });
    expect(JSON.parse(result.content[0].text)).toEqual({ session: 's1' });
    expect(bridgeArgs()[0]).toEqual(['research_start', 'nb', 'topic']);
  });

  it('notebook_notes list calls notes_list; create calls note_create with defaults', async () => {
    nextStdout = JSON.stringify({ notes: [] });
    await tools.notebook_notes.handler({ notebookId: 'nb', action: 'list' });
    await tools.notebook_notes.handler({ notebookId: 'nb', action: 'create', title: 'N', content: 'C' });
    await tools.notebook_notes.handler({ notebookId: 'nb', action: 'create' });
    expect(bridgeArgs()).toEqual([
      ['notes_list', 'nb'],
      ['note_create', 'nb', 'N', 'C'],
      ['note_create', 'nb', 'Untitled', ''],
    ]);
  });

  it('notebook_download prefixes the artifact type with download_ and forwards outputPath', async () => {
    nextStdout = JSON.stringify({ path: '/o/a.mp3' });
    const result = await tools.notebook_download.handler({ notebookId: 'nb', artifactType: 'audio', outputPath: '/o/a.mp3' });
    expect(JSON.parse(result.content[0].text)).toEqual({ path: '/o/a.mp3' });
    expect(bridgeArgs()[0]).toEqual(['download_audio', 'nb', '/o/a.mp3']);
  });

  it('returns isError with a formatted recovery hint when bridge reports an error', async () => {
    nextStdout = JSON.stringify({ error: 'expired token', recovery: 're-run NOTEBOOKLM_REFRESH_CMD' });
    const result = await tools.notebook_list.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('NotebookLM Error: expired token\nRecovery: re-run NOTEBOOKLM_REFRESH_CMD');
  });

  it('returns the stringified payload (no error) when the bridge object has no error field', async () => {
    nextStdout = JSON.stringify({ unexpected: true });
    const result = await tools.notebook_list.handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ unexpected: true });
  });

  it('returns isError with the error message when the bridge subprocess throws', async () => {
    nextError = new Error('spawn ENOENT');
    const result = await tools.notebook_list.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: spawn ENOENT');
  });

  it('passes a 120s timeout and 10MB maxBuffer to execFile', async () => {
    nextStdout = '{}';
    await tools.notebook_list.handler({});
    expect(execCalls[0].opts).toMatchObject({ timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  });
});