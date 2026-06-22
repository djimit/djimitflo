import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentCatalog, parseAgentMarkdown, normalizeAgent, runStaticGate, validateSchema, scanInjection, overlapScore, compile } from '../src';

const FIX = (f: string) => readFileSync(join(process.cwd(), 'fixtures/agents', f), 'utf8');

describe('parser', () => {
  it('extracts frontmatter and level-2 sections', () => {
    const p = parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/secure-coder.md' });
    expect(p.frontmatter.name).toBe('Secure Coder');
    expect(p.sections.mission).toBeTruthy();
    expect(p.sections.rules).toBeTruthy();
  });
});

describe('normalize', () => {
  it('derives division from path and computes version_hash', () => {
    const p = parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/secure-coder.md' });
    const prof = normalizeAgent(p);
    expect(prof.name).toBe('Secure Coder');
    expect(prof.division).toBe('engineering');
    expect(prof.id).toMatch(/^engineering-secure-coder$/);
    expect(prof.version_hash).toHaveLength(16);
  });
});

describe('gate', () => {
  it('validates a clean profile', () => {
    const prof = normalizeAgent(parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/secure-coder.md' }));
    expect(validateSchema(prof).valid).toBe(true);
  });
  it('flags injection in evil fixture as critical', () => {
    const r = scanInjection(FIX('injected-evil.md'));
    expect(r.score).toBeGreaterThanOrEqual(6);
    expect(r.level).toBe('critical');
    expect(r.flags).toContain('instruction-override');
  });
  it('clean profile has zero injection score', () => {
    expect(scanInjection(FIX('secure-coder.md')).score).toBe(0);
  });
  it('detects near-duplicate (overlap >= 0.85)', () => {
    const a = normalizeAgent(parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/a.md' }));
    const b = normalizeAgent(parseAgentMarkdown(FIX('dup-secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/b.md' }));
    expect(overlapScore(a, b)).toBeGreaterThanOrEqual(0.85);
  });
});

describe('catalog e2e', () => {
  it('imports fixtures: evil + dup rejected, exactly one of the pair passed', () => {
    const cat = new AgentCatalog();
    const results = cat.importDir(join(process.cwd(), 'fixtures/agents'), 'msitarzewski/agency-agents');
    const byName = Object.fromEntries(results.map(r => [r.profile.name, r]));
    expect(byName['Helpful Assistant'].evaluation.status).toBe('rejected');
    const pair = ['Secure Coder', 'Security Coder'].map(n => byName[n].evaluation.status);
    expect(pair.filter(x => x === 'passed').length).toBe(1);
    expect(pair.filter(x => x === 'rejected').length).toBe(1);
    const c = cat.counts();
    expect(c.total).toBe(3);
    expect(c.passed).toBe(1);
    expect(c.duplicate).toBeGreaterThanOrEqual(1);
    expect(c.active).toBe(0);
    cat.close();
  });
});

describe('activation', () => {
  it('blocks activation without a passing evaluation', () => {
    const cat = new AgentCatalog();
    cat.importDir(join(process.cwd(), 'fixtures/agents'), 'r');
    const evil = cat.list().find(p => p.name === 'Helpful Assistant')!;
    expect(() => cat.registry.activate(evil.id, 'openclaw')).toThrow(/evaluation not passed/);
    cat.close();
  });
  it('blocks activation with no evaluation record at all', () => {
    const cat = new AgentCatalog();
    cat.db.upsertProfile({ id: 'x/y', name: 'Y', division: 'd', source_repo: 'r', source_path: 'p', version_hash: 'h', persona: '', mission: '', rules: [], workflows: [], deliverables: [], success_metrics: [], memory_policy: '', tools_required: [], runtime_targets: [], risk_profile: { level: 'low', injection_score: 0, overlap_score: 0, flags: [] }, evaluation_status: 'pending', activation_status: 'draft' } as any);
    expect(() => cat.registry.activate('x/y', 'openclaw')).toThrow(/no evaluation record/);
    cat.close();
  });
  it('activates a passed profile and is reversible', () => {
    const cat = new AgentCatalog();
    cat.importDir(join(process.cwd(), 'fixtures/agents'), 'r');
    const passed = cat.list().find(p => cat.db.getEvaluation(p.id)?.status === 'passed')!;
    expect(passed).toBeTruthy();
    const act = cat.registry.activate(passed.id, 'openclaw');
    expect(act.status).toBe('active');
    expect(act.artifact.files['SOUL.md']).toBeTruthy();
    expect(cat.registry.status(passed.id).status).toBe('active');
    expect(cat.registry.deactivate(passed.id).status).toBe('deactivated');
    cat.close();
  });
});

describe('compile', () => {
  it('OpenClaw + Codex produce artifacts', () => {
    const prof = normalizeAgent(parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/a.md' }));
    const oc = compile(prof, 'openclaw');
    expect(Object.keys(oc.files).sort()).toEqual(['AGENTS.md', 'IDENTITY.md', 'SOUL.md']);
    const cx = compile(prof, 'codex');
    expect(cx.files['agent.toml']).toContain('[agent]');
    expect(cx.files['agent.toml']).toContain('Secure Coder');
  });
  it('stub targets flagged', () => {
    const prof = normalizeAgent(parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/a.md' }));
    for (const t of ['claude-code', 'cursor', 'gemini-cli'] as const) expect(compile(prof, t).stub).toBe(true);
  });
});
