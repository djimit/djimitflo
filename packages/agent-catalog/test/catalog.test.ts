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
  it('preserves a manual rejection and exact score on same-version reimport but assesses changed versions freshly', () => {
    const cat = new AgentCatalog();
    const options = { sourceRepo: 'fixture', sourcePath: 'engineering/secure.md' };
    try {
      const first = cat.importText(FIX('secure-coder.md'), options);
      cat.db.setEvaluation({ ...first.evaluation, status: 'rejected', score: 32.25, flags: ['manual-evaluation:fixture-reviewer'] }, first.profile.version_hash);
      const repeated = cat.importText(FIX('secure-coder.md'), options);
      expect(repeated.profile.version_hash).toBe(first.profile.version_hash);
      expect(repeated.evaluation).toMatchObject({ status: 'rejected', score: 32.25 });
      expect(repeated.evaluation.flags).toContain('manual-evaluation:fixture-reviewer');
      expect(cat.db.getEvaluation(first.profile.id)).toMatchObject({ status: 'rejected', score: 32.25 });
      expect(() => cat.registry.activate(first.profile.id, 'codex')).toThrow(/evaluation not passed/);
      const changed = cat.importText(FIX('secure-coder.md').replace('Deliver code that is correct', 'Deliver newly scoped fixture code that is correct'), options);
      expect(changed.profile.version_hash).not.toBe(first.profile.version_hash);
      expect(changed.evaluation.status).toBe('passed');
      expect(changed.evaluation.score).toBeUndefined();
      expect(changed.evaluation.flags).not.toContain('manual-evaluation:fixture-reviewer');
    } finally { cat.close(); }
  });

  it('preserves both the active artifact and stored profile activation status on unchanged manual-approved reimport', () => {
    const cat = new AgentCatalog();
    const options = { sourceRepo: 'fixture', sourcePath: 'engineering/secure.md' };
    try {
      const first = cat.importText(FIX('secure-coder.md'), options);
      cat.db.setEvaluation({ ...first.evaluation, status: 'passed', score: 87.5, flags: ['manual-evaluation:fixture-reviewer'] }, first.profile.version_hash);
      cat.registry.activate(first.profile.id, 'codex');
      const repeated = cat.importText(FIX('secure-coder.md'), options);
      expect(repeated.evaluation).toMatchObject({ status: 'passed', score: 87.5 });
      expect(repeated.profile.activation_status).toBe('active');
      expect(cat.db.getProfile(first.profile.id)?.activation_status).toBe('active');
      expect(cat.registry.status(first.profile.id).status).toBe('active');
    } finally { cat.close(); }
  });

  it('lets a newly failing static gate block a same-version manual approval without erasing its provenance', () => {
    const cat = new AgentCatalog();
    const options = { sourceRepo: 'fixture', sourcePath: 'engineering/secure.md' };
    try {
      const first = cat.importText(FIX('secure-coder.md'), options);
      cat.db.setEvaluation({ ...first.evaluation, status: 'passed', score: 87.5, flags: ['manual-evaluation:fixture-reviewer'] }, first.profile.version_hash);
      cat.registry.activate(first.profile.id, 'codex');
      cat.importText(FIX('dup-secure-coder.md'), { ...options, sourcePath: 'engineering/duplicate.md' });
      const repeated = cat.importText(FIX('secure-coder.md'), options);
      expect(repeated.profile.version_hash).toBe(first.profile.version_hash);
      expect(repeated.evaluation).toMatchObject({ status: 'rejected', score: 87.5 });
      expect(repeated.evaluation.flags).toEqual(expect.arrayContaining(['manual-evaluation:fixture-reviewer', 'manual-verdict:passed', 'near-duplicate']));
      expect(repeated.profile.activation_status).toBe('deactivated');
      expect(cat.registry.status(first.profile.id).status).toBe('deactivated');
      expect(() => cat.registry.activate(first.profile.id, 'codex')).toThrow(/evaluation not passed/);
      const again = cat.importText(FIX('secure-coder.md'), options);
      expect(again.evaluation).toMatchObject({ status: 'rejected', score: 87.5 });
      expect(again.evaluation.flags).toContain('manual-verdict:passed');
    } finally { cat.close(); }
  });

  it('replaces duplicate edges when a formerly overlapping profile becomes unique', () => {
    const cat = new AgentCatalog();
    const options = { sourceRepo: 'fixture', sourcePath: 'engineering/duplicate.md' };
    try {
      cat.importText(FIX('secure-coder.md'), { ...options, sourcePath: 'engineering/secure.md' });
      const duplicate = cat.importText(FIX('dup-secure-coder.md'), options);
      expect(cat.counts()).toMatchObject({ duplicate: 1, rejected: 1 });
      const unique = cat.importText('---\nname: Security Coder\ndescription: We catalogue ocean tides and seasonal plankton migration.\nvibe: Marine scientist collecting habitat observations.\n---\n## Mission\nEstimate water salinity using independent marine instruments.\n', options);
      expect(unique.profile.id).toBe(duplicate.profile.id);
      expect(unique.evaluation).toMatchObject({ overlap_score: 0, status: 'passed' });
      expect(cat.counts()).toMatchObject({ total: 2, passed: 2, rejected: 0, duplicate: 0 });
    } finally { cat.close(); }
  });

  it('rolls back the profile, evaluation and overlap snapshot if replacement edges cannot be stored', () => {
    const cat = new AgentCatalog();
    const options = { sourceRepo: 'fixture', sourcePath: 'engineering/duplicate.md' };
    try {
      cat.importText(FIX('secure-coder.md'), { ...options, sourcePath: 'engineering/secure.md' });
      const duplicate = cat.importText(FIX('dup-secure-coder.md'), options);
      const before = cat.db.getEvaluation(duplicate.profile.id);
      (cat.db as any).db.exec("CREATE TRIGGER fail_overlap_insert BEFORE INSERT ON overlaps BEGIN SELECT RAISE(ABORT,'overlap storage unavailable'); END");
      expect(() => cat.importText(FIX('dup-secure-coder.md').replace('Writes defensive', 'Writes thoroughly defensive'), options)).toThrow('overlap storage unavailable');
      expect(cat.db.getProfile(duplicate.profile.id)?.version_hash).toBe(duplicate.profile.version_hash);
      expect(cat.db.getEvaluation(duplicate.profile.id)).toEqual(before);
      expect(cat.counts()).toMatchObject({ total: 2, passed: 1, rejected: 1, duplicate: 1 });
    } finally { cat.close(); }
  });

  it('enforces the declared profile foreign keys at the storage boundary', () => {
    const cat = new AgentCatalog();
    try {
      const {profile,evaluation} = cat.importText(FIX('secure-coder.md'), {sourceRepo:'fixture',sourcePath:'engineering/secure.md'});
      expect(() => cat.db.setEvaluation({...evaluation,profile_id:'missing-profile'}, profile.version_hash)).toThrow(/FOREIGN KEY/);
      expect(() => cat.db.setActivation('missing-profile','active','codex','{}')).toThrow(/FOREIGN KEY/);
      expect(cat.counts()).toMatchObject({total:1,evaluated:1,active:0});
    } finally { cat.close(); }
  });
  it('invalidates active artifacts when the profile changes and selects the current evaluation', () => {
    const cat = new AgentCatalog();
    try {
      const first = cat.importText(FIX('secure-coder.md'), { sourceRepo:'fixture', sourcePath:'engineering/secure.md' });
      cat.registry.activate(first.profile.id, 'codex');
      const second = cat.importText(FIX('secure-coder.md').replace('Deliver code that is correct', 'Deliver bounded fixture code that is correct'), {sourceRepo:'fixture',sourcePath:'engineering/secure.md'});
      expect(second.profile.version_hash).not.toBe(first.profile.version_hash);
      expect(cat.registry.status(first.profile.id).status).not.toBe('active');
      expect(cat.counts().active).toBe(0);
      expect(cat.db.getEvaluation(first.profile.id).version_hash).toBe(second.profile.version_hash);
      expect(cat.registry.activate(first.profile.id, 'codex').status).toBe('active');
    } finally { cat.close(); }
  });

  it('revokes active artifact on failed reevaluation and counts only the current version', () => {
    const cat = new AgentCatalog();
    try {
      const {profile,evaluation} = cat.importText(FIX('secure-coder.md'), {sourceRepo:'fixture',sourcePath:'engineering/secure.md'});
      cat.registry.activate(profile.id, 'codex');
      cat.db.setEvaluation({...evaluation,status:'rejected'}, profile.version_hash);
      expect(cat.registry.status(profile.id).status).not.toBe('active');
      cat.db.upsertProfile({...profile,version_hash:'new-version',evaluation_status:'passed'});
      cat.db.setEvaluation({...evaluation,status:'passed'}, 'new-version');
      expect(cat.counts()).toMatchObject({evaluated:1,passed:1,rejected:0});
    } finally { cat.close(); }
  });

  it('rolls back activation if its audit record cannot be stored', () => {
    const cat = new AgentCatalog();
    try {
      const {profile} = cat.importText(FIX('secure-coder.md'), {sourceRepo:'fixture',sourcePath:'engineering/secure.md'});
      (cat.db as any).db.exec("CREATE TRIGGER fail_activation_audit BEFORE INSERT ON audit_ledger WHEN NEW.action='activate' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
      expect(() => cat.registry.activate(profile.id,'codex')).toThrow('audit unavailable');
      expect(cat.registry.status(profile.id).status).not.toBe('active');
    } finally { cat.close(); }
  });
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
  it('blocks activation after the evaluated profile changes', () => {
    const cat = new AgentCatalog();
    cat.importDir(join(process.cwd(), 'fixtures/agents'), 'r');
    const passed = cat.list().find(p => cat.db.getEvaluation(p.id)?.status === 'passed')!;
    cat.db.upsertProfile({ ...passed, version_hash: `${passed.version_hash}-changed` });

    expect(() => cat.registry.activate(passed.id, 'openclaw')).toThrow(/evaluation is stale/);
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
  it('all declared targets compile usable instruction artifacts', () => {
    const prof = normalizeAgent(parseAgentMarkdown(FIX('secure-coder.md'), { sourceRepo: 'r', sourcePath: 'engineering/a.md' }));
    for (const t of ['claude-code', 'cursor', 'gemini-cli'] as const) {
      const artifact = compile(prof, t);
      expect(artifact.stub).toBeUndefined();
      expect(Object.values(artifact.files).join('\n')).toContain('Deliver code that is correct');
      expect(Object.values(artifact.files).join('\n')).not.toContain('F5 stub');
    }
  });
});
