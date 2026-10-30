import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserRole } from '@djimitflo/shared';
import { registerNotebookTools } from '../tools/notebooks.js';
import { runWithMcpAuth } from '../auth-context.js';

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

// every call runs as a principal (the stdio default is a viewer); writes need write:evidence, which a maker holds
function toolsOf(server: McpServer, role: UserRole = UserRole.MAKER): ToolBox {
  const registered = (server as unknown as { _registeredTools: ToolBox })._registeredTools;
  return Object.fromEntries(Object.entries(registered).map(([name, tool]) => [name, {
    handler: (input?: unknown) => runWithMcpAuth({ payload: { sub: `test-${role}`, role, email: `${role}@test`, iat: 0, exp: 9999999999 }, token: 'fixture' },
      () => tool.handler(input)),
  }]));
}

const bridgeArgs = () => execCalls.map((c) => c.bridgeArgs);

describe('NotebookLM MCP tools (registerNotebookTools)', () => {
  let server: McpServer;
  let tools: ToolBox;

  let outDir: string;

  beforeEach(() => {
    execCalls = [];
    nextStdout = null;
    nextError = null;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-out-'));
    vi.stubEnv('NOTEBOOKLM_OUTPUT_DIR', outDir);
    server = new McpServer({ name: 'notebooks-test', version: '0' });
    registerNotebookTools(server);
    tools = toolsOf(server);
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); fs.rmSync(outDir, { recursive: true, force: true }); });

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

  it('notebook_download prefixes the artifact type with download_ and forwards outputPath inside the notebook directory', async () => {
    nextStdout = JSON.stringify({ path: 'a.mp3' });
    const result = await tools.notebook_download.handler({ notebookId: 'nb', artifactType: 'audio', outputPath: 'a.mp3' });
    expect(JSON.parse(result.content[0].text)).toEqual({ path: 'a.mp3' });
    expect(bridgeArgs()[0]).toEqual(['download_audio', 'nb', path.join(fs.realpathSync(outDir), 'a.mp3')]);
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

/**
 * D-security 30-10 B11 / candidate 10: the nine notebook tools had 0 permission checks (a viewer, the stdio default, could
 * create/delete notebooks and push sources) and notebook_download wrote to any outputPath. Writes now need write:evidence
 * like the other MCP write tools, and the download path is confined to the notebook directory.
 */
describe('NotebookLM MCP tools: write permission and output path confinement', () => {
  let server: McpServer;
  let outDir: string;

  beforeEach(() => {
    execCalls = [];
    nextStdout = JSON.stringify({ ok: true });
    nextError = null;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-out-'));
    vi.stubEnv('NOTEBOOKLM_OUTPUT_DIR', outDir);
    server = new McpServer({ name: 'notebooks-perm-test', version: '0' });
    registerNotebookTools(server);
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); fs.rmSync(outDir, { recursive: true, force: true }); });

  const writes: Array<[string, Record<string, unknown>]> = [
    ['notebook_create', { title: 'New' }],
    ['notebook_delete', { notebookId: 'nb' }],
    ['notebook_add_source', { notebookId: 'nb', type: 'file', value: '/etc/passwd' }],
    ['notebook_generate', { notebookId: 'nb', artifactType: 'audio' }],
    ['notebook_download', { notebookId: 'nb', artifactType: 'audio', outputPath: 'a.mp3' }],
    ['notebook_research', { notebookId: 'nb', query: 'topic' }],
    ['notebook_notes', { notebookId: 'nb', action: 'create', title: 'N', content: 'C' }],
  ];

  it.each(writes)('a viewer gets MCP_PERMISSION_DENIED from %s and the bridge is never called', async (name, input) => {
    const result = await toolsOf(server, UserRole.VIEWER)[name].handler(input);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: MCP_PERMISSION_DENIED: write:evidence');
    expect(execCalls).toEqual([]);
  });

  it('a call without any principal is refused too', async () => {
    const raw = (server as unknown as { _registeredTools: ToolBox })._registeredTools;
    const result = await raw.notebook_create.handler({ title: 'x' });
    expect(result.isError).toBe(true);
    expect(execCalls).toEqual([]);
  });

  it('reads stay open to a viewer: list, ask, notes list', async () => {
    const tools = toolsOf(server, UserRole.VIEWER);
    for (const [name, input] of [['notebook_list', {}], ['notebook_ask', { notebookId: 'nb', question: 'q' }], ['notebook_notes', { notebookId: 'nb', action: 'list' }]] as const) {
      expect((await tools[name].handler(input)).isError).toBeUndefined();
    }
    expect(bridgeArgs().map((a) => a[0])).toEqual(['list', 'ask', 'notes_list']);
  });

  it.each(['/etc/cron.d/x', '../escape.mp3', 'sub/../../escape.mp3'])('notebook_download refuses outputPath %s outside the notebook directory', async (outputPath) => {
    const result = await toolsOf(server, UserRole.ADMIN).notebook_download.handler({ notebookId: 'nb', artifactType: 'audio', outputPath });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NOTEBOOK_OUTPUT_PATH_OUTSIDE_DIR');
    expect(execCalls).toEqual([]);
  });

  it('notebook_download refuses a path through a symlink that leaves the notebook directory', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(outDir, 'link'));
      const result = await toolsOf(server, UserRole.ADMIN).notebook_download.handler({ notebookId: 'nb', artifactType: 'report', outputPath: 'link/r.md' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('NOTEBOOK_OUTPUT_PATH_OUTSIDE_DIR');
      expect(execCalls).toEqual([]);
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });

  it('an absolute path inside the notebook directory is accepted', async () => {
    const inside = path.join(fs.realpathSync(outDir), 'sub', 'q.json');
    await toolsOf(server, UserRole.ADMIN).notebook_download.handler({ notebookId: 'nb', artifactType: 'quiz', outputPath: inside });
    expect(bridgeArgs()[0]).toEqual(['download_quiz', 'nb', inside]);
  });
});
