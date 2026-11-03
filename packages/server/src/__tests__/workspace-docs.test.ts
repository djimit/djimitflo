import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { AgentsMdFile } from '@djimitflo/shared';
import { AgentsMdValidator } from '../services/agents-md-validator';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { RUNTIME_ADMISSIONS } from '../execution/runtime-admission';

/** Workspace files (operator 18-10): the repo's own AGENTS.md passes our validator; TOOLS.md / HEARTBEAT.md are fresh. */
const ROOT = path.resolve(__dirname, '../../../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
type Gen = {
  check: (root?: string) => string[];
  parseEvolutionFlags: (src: string) => Array<{ name: string; acting: boolean }>;
  parseAdmissions: (src: string) => Array<{ runtime_id: string; runtime_version: string | null }>;
};
const gen = async () => (await import('../../../../scripts/gen-agent-docs.mjs')) as Gen;

describe('workspace files', () => {
  it('AGENTS.md has no validator issue (errors and criticals fail CI; warnings and infos too)', () => {
    const content = read('AGENTS.md');
    const now = new Date().toISOString();
    const file: AgentsMdFile = { id: 'repo-agents-md', repositoryId: 'djimitflo', path: path.join(ROOT, 'AGENTS.md'), relativePath: 'AGENTS.md', appliesToPath: '/',
      contentHash: '', sizeBytes: content.length, content, discoveredAt: now, createdAt: now, updatedAt: now };
    expect(new AgentsMdValidator().validateFile(file).map((i) => `${i.severity}: ${i.ruleId}`)).toEqual([]);
  });

  it('AGENTS.md is self-contained and links the other workspace files', () => {
    const content = read('AGENTS.md');
    expect(content).not.toMatch(/^@\.\.\//m); // no import from outside the repo (absent in prod)
    for (const f of ['SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'openspec/specs/core-invariants/spec.md']) expect(content).toContain(`(${f})`);
    expect(content).toContain('<!-- SPECKIT START -->');
    expect(content).toContain('<!-- OPENWIKI:START -->');
  });

  it('loaders are thin: CLAUDE.md imports AGENTS.md, the Ponytail layer lives once (SOUL.md)', () => {
    expect(read('CLAUDE.md')).toMatch(/^@AGENTS\.md$/m);
    expect(read('CLAUDE.md')).not.toContain('@../');
    expect(read('.github/copilot-instructions.md')).not.toContain('Ponytail Simplicity Layer');
    expect(read('SOUL.md')).toContain('Ponytail');
    expect(read('USER.md')).toMatch(/not for private data/i);
  });

  it('generated TOOLS.md / HEARTBEAT.md are fresh and all five files are within their line budgets', async () => {
    expect((await gen()).check(ROOT)).toEqual([]);
  });

  it('the generator parses the real EVOLUTION_FLAGS and RUNTIME_ADMISSIONS exactly', async () => {
    const g = await gen();
    expect(g.parseEvolutionFlags(read('packages/server/src/services/evolution-evidence.ts'))).toEqual(EVOLUTION_FLAGS);
    expect(g.parseAdmissions(read('packages/server/src/execution/runtime-admission.ts')).map((a) => [a.runtime_id, a.runtime_version]))
      .toEqual(RUNTIME_ADMISSIONS.map((a) => [a.runtime_id, a.runtime_version]));
  });
});
