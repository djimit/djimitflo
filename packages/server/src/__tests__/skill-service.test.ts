import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillService } from '../services/skill-service';

const synthesis = [
  'Use a small, explicit procedure and validate the result.',
  'Sources:',
  '- https://docs.example.test/one',
  '- https://research.example.test/two',
  '- https://standards.example.test/three',
].join('\n');

describe('SkillService.acquire', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: SkillService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-skill-'));
    vi.stubEnv('OKF_BASE', path.join(tempDir, 'okf'));
    vi.stubEnv('DEERFLOW_URL', 'http://deerflow.example.test');
    db = new Database(':memory:');
    service = new SkillService(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates a skill with the existing frontmatter contract', () => {
    fs.writeFileSync(path.join(tempDir, 'okf', 'skills', 'test-skill.md'), `---
type: Skill
title: "Test Skill"
description: "A test skill"
trust_level: agent_generated
status: draft
timestamp: 2026-06-14T00:00:00Z
---

# Test Skill

Some content here.
`, 'utf8');

    expect(service.validate('test-skill', 'process').status).toBe('validated');
  });

  it('rejects missing or incomplete skill frontmatter', () => {
    fs.writeFileSync(path.join(tempDir, 'okf', 'skills', 'bad-skill.md'), 'No frontmatter here', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'okf', 'skills', 'incomplete-skill.md'), '---\ntitle: Missing type\n---\n', 'utf8');

    expect(service.validate('bad-skill', 'process').status).toBe('failed');
    expect(service.validate('incomplete-skill', 'process').status).toBe('failed');
  });

  it('fails closed when Docker validation is unavailable', () => {
    fs.writeFileSync(path.join(tempDir, 'okf', 'skills', 'docker-skill.md'), '---\ntype: Skill\ntitle: Docker Skill\ntrust_level: agent_generated\nstatus: draft\n---\n', 'utf8');

    expect(service.validate('docker-skill', 'docker').status).toBe('failed');
    expect(fs.readFileSync(path.join(tempDir, 'okf', 'skills', 'docker-skill.md'), 'utf8')).toContain('status: draft');
  });

  it('refuses to push draft skills', async () => {
    fs.writeFileSync(path.join(tempDir, 'okf', 'skills', 'draft-skill.md'), '---\ntype: Skill\ntitle: Draft\ntrust_level: agent_generated\nstatus: draft\n---\n', 'utf8');

    const result = await service.push('test-agent', 'draft-skill', 'ssh');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not validated');
  });

  it('uses the DeerFlow thread/run API and only writes a cited draft after success', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, any> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/threads')) {
        return new Response(JSON.stringify({ thread_id: body.thread_id }), { status: 200 });
      }
      return new Response(JSON.stringify({ values: { messages: [{ type: 'ai', content: synthesis }] } }), { status: 200 });
    });

    const result = await service.acquire('Evidence-based testing');

    expect(result.status).toBe('draft');
    expect(calls.map(({ url, method }) => [method, url])).toEqual([
      ['POST', 'http://deerflow.example.test/api/threads'],
      ['POST', expect.stringMatching(/\/api\/threads\/djimitflo-research-[^/]+\/runs\/wait$/)],
    ]);
    expect(calls[1].body).toMatchObject({ on_completion: 'delete' });
    const file = path.join(tempDir, 'okf', 'skills', 'evidence-based-testing.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('https://standards.example.test/three');
    expect(fs.readFileSync(file, 'utf8')).toContain('status: draft');
  });

  it('does not write a placeholder when DeerFlow rejects the run and cleans up its thread', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/threads')) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ thread_id: body.thread_id }), { status: 200 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('{}', { status: 404 });
    });

    const result = await service.acquire('Unavailable research');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('DEERFLOW_RESEARCH_UNAVAILABLE_OR_UNVERIFIED');
    expect(fs.existsSync(path.join(tempDir, 'okf', 'skills', 'unavailable-research.md'))).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2][1]?.method).toBe('DELETE');
  });

  it('rejects short or unauthored research evidence without persisting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/threads')) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ thread_id: body.thread_id }), { status: 200 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ values: { messages: [{ type: 'ai', content: 'Only https://one.example.test/source is cited.' }] } }), { status: 200 });
    });

    const result = await service.acquire('Insufficient citations');

    expect(result.status).toBe('failed');
    expect(fs.existsSync(path.join(tempDir, 'okf', 'skills', 'insufficient-citations.md'))).toBe(false);
  });

  it('does not overwrite an existing canonical skill', async () => {
    const file = path.join(tempDir, 'okf', 'skills', 'existing-skill.md');
    fs.writeFileSync(file, 'user-owned content\n');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await service.acquire('Existing Skill');

    expect(result.error).toBe('SKILL_ALREADY_EXISTS');
    expect(fs.readFileSync(file, 'utf8')).toBe('user-owned content\n');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
