import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerOkfTools, resolveOkfBase } from '../tools/okf.js';

const original = process.env.OKF_BASE;

afterEach(() => {
  if (original === undefined) delete process.env.OKF_BASE;
  else process.env.OKF_BASE = original;
});

describe('OKF path resolution', () => {
  it('uses the explicit OKF base in ESM', () => {
    process.env.OKF_BASE = './okf';
    expect(resolveOkfBase()).toBe(`${process.cwd()}/okf`);
  });
});

describe('okf_get path containment (P0-2)', () => {
  it('refuses traversal, absolute paths and symlink escapes but serves a normal concept', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-get-'));
    const base = path.join(root, 'okf');
    fs.mkdirSync(path.join(base, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'a.md'), '---\ntype: agent\n---\n# A');
    fs.writeFileSync(path.join(root, 'secret.env'), 'JWT_SECRET=leak');
    fs.symlinkSync(path.join(root, 'secret.env'), path.join(base, 'agents', 'link.md'));
    process.env.OKF_BASE = base;
    try {
      const server = new McpServer({ name: 'okf-test', version: '0' });
      registerOkfTools(server);
      const okfGet = (server as any)._registeredTools.okf_get.handler as (i: object) => Promise<any>;
      for (const conceptPath of ['../../etc/passwd', '../secret.env', '/etc/passwd', path.join(root, 'secret.env'), 'agents/link.md']) {
        const result = await okfGet({ conceptPath });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toContain('leak');
        expect(result.content[0].text).not.toContain('root:');
      }
      const ok = await okfGet({ conceptPath: 'agents/a.md' });
      expect(ok.isError).not.toBe(true);
      expect(JSON.parse(ok.content[0].text).content).toContain('# A');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
