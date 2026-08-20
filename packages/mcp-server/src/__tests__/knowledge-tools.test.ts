import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporary: string[] = [];
const envKeys = ['NOTEBOOKLM_PYTHON', 'NOTEBOOKLM_BRIDGE_PATH', 'OKF_BASE'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('knowledge MCP tool contracts', () => {
  it('executes every NotebookLM tool through the configured bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'djimitflo-notebook-tools-'));
    temporary.push(dir);
    const bridge = join(dir, 'bridge.sh');
    writeFileSync(bridge, '#!/bin/sh\nprintf \'{"args":[\'\nfirst=1\nfor arg in "$@"; do [ $first -eq 0 ] && printf ,; printf \'"%s"\' "$arg"; first=0; done\nprintf \']}\'\n');
    process.env.NOTEBOOKLM_PYTHON = '/bin/sh';
    process.env.NOTEBOOKLM_BRIDGE_PATH = bridge;

    const { registerNotebookTools } = await import('../tools/notebooks.js');
    const server = new McpServer({ name: 'notebook-test', version: '0' });
    registerNotebookTools(server);
    const tools = (server as any)._registeredTools;
    const calls: Record<string, object> = {
      notebook_list: {}, notebook_create: { title: 'Title' }, notebook_delete: { notebookId: 'n1' },
      notebook_add_source: { notebookId: 'n1', type: 'text', value: 'body', title: 'Source' },
      notebook_ask: { notebookId: 'n1', question: 'Question?' },
      notebook_generate: { notebookId: 'n1', artifactType: 'report' },
      notebook_research: { notebookId: 'n1', query: 'topic' },
      notebook_notes: { notebookId: 'n1', action: 'create', title: 'Note', content: 'Body' },
      notebook_download: { notebookId: 'n1', artifactType: 'report', outputPath: '/tmp/report.pdf' },
    };

    for (const [name, input] of Object.entries(calls)) {
      const result = await tools[name].handler(input);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text).args.length).toBeGreaterThan(0);
    }
  });

  it('executes every OKF tool against a real temporary bundle', async () => {
    const base = mkdtempSync(join(tmpdir(), 'djimitflo-okf-tools-'));
    temporary.push(base);
    mkdirSync(join(base, 'concepts'));
    const frontmatter = (title: string) => `---\ntype: Concept\ntitle: ${title}\ndescription: test\ntimestamp: 2026-01-01\ntags: [test]\n---\n`;
    writeFileSync(join(base, 'concepts', 'alpha.md'), `${frontmatter('Alpha')}alpha body [[concepts/beta.md]]`);
    writeFileSync(join(base, 'concepts', 'beta.md'), `${frontmatter('Beta')}beta body`);
    process.env.OKF_BASE = base;

    const { registerOkfTools } = await import('../tools/okf.js');
    const server = new McpServer({ name: 'okf-test', version: '0' });
    registerOkfTools(server);
    const tools = (server as any)._registeredTools;

    expect(JSON.parse((await tools.okf_search.handler({ query: 'alpha' })).content[0].text).total).toBe(1);
    expect(JSON.parse((await tools.okf_get.handler({ conceptPath: 'concepts/alpha.md' })).content[0].text).path).toBe('concepts/alpha.md');
    expect(JSON.parse((await tools.okf_related.handler({ conceptPath: 'concepts/alpha.md', depth: 1 })).content[0].text).related_count).toBe(1);
    expect(JSON.parse((await tools.okf_validate.handler({ strict: true })).content[0].text).status).toBe('PASS');
    expect(JSON.parse((await tools.okf_status.handler({})).content[0].text)).toMatchObject({ total_files: 2, status: 'healthy' });
  });
});
