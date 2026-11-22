import { expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

/**
 * B29: the negative-evidence registry (docs/research/negative-evidence) is permanent. Its schema is checked here, and an
 * entry with a closing verdict forbids its `forbidden_code_patterns` in the server source, so a rejected approach
 * (NE-001: jev cascade routing of the proposal pre-screen) cannot be silently rebuilt.
 */
const repo = path.resolve(__dirname, '../../../..');
const REGISTRY = path.join(repo, 'docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml');
const VERDICTS = ['REJECT', 'NO_GO', 'FALSIFIED', 'INCONCLUSIVE'];
const CLOSED = ['REJECT', 'NO_GO', 'FALSIFIED'];
type Entry = { id: string; hypothesis: string; verdict: string; evidence: string[]; reopen_condition: string; forbidden_code_patterns?: string[] };
// JSON is valid YAML 1.2; the registry is kept in that subset so no YAML dependency is needed
const registry = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { version: number; entries: Entry[] };

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' || d.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(ts|tsx|mjs|js)$/.test(d.name) ? [p] : [];
  });
}

it('B29: every negative-evidence entry has an id, hypothesis, verdict, evidence refs and a reopen condition', () => {
  const { entries } = registry();
  expect(entries.length).toBeGreaterThan(0);
  const ids = new Set<string>();
  for (const e of entries) {
    expect(e.id).toMatch(/^NE-\d{3}$/);
    expect(ids.has(e.id)).toBe(false); ids.add(e.id);
    expect(typeof e.hypothesis === 'string' && e.hypothesis.length > 10).toBe(true);
    expect(VERDICTS).toContain(e.verdict);
    expect(Array.isArray(e.evidence) && e.evidence.length > 0).toBe(true);
    expect(typeof e.reopen_condition === 'string' && e.reopen_condition.length > 10).toBe(true);
  }
  const ne1 = entries.find((e) => e.id === 'NE-001');
  expect(ne1?.verdict).toBe('REJECT');
  expect(ne1?.evidence.join(' ')).toContain('fbc9c5d180929c43844ec8beca26bd5fbd7a62ca43b472c3efc369c0b08bbab1');
});

/** Dependency names in a package-lock.json (keys only; integrity/resolved blobs are not scanned). */
function lockNames(lock: Record<string, unknown>): string[] {
  const names: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = n[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, sub] of Object.entries(deps as Record<string, unknown>)) { names.push(name); walk(sub); }
    }
  };
  for (const [key, pkg] of Object.entries((lock.packages ?? {}) as Record<string, unknown>)) { names.push(key); walk(pkg); }
  walk(lock);
  return names;
}

/** Where a forbidden dependency, hook command or MCP entry would land: package manifests, lockfile names, MCP and agent settings (incl. Roo Code's .roo/mcp.json and .roomodes). */
function configTexts(root: string): { file: string; text: string }[] {
  const ls = (dir: string, re: RegExp) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : []);
  const pkgDirs = fs.existsSync(path.join(root, 'packages')) ? fs.readdirSync(path.join(root, 'packages')).map((d) => path.join('packages', d, 'package.json')) : [];
  const files = ['package.json', ...pkgDirs, '.mcp.json', path.join('.vscode', 'mcp.json'), path.join('.roo', 'mcp.json'), '.roomodes', ...ls('.claude', /^settings.*\.json$/), ...ls('.opencode', /\.json$/)];
  const out = files.filter((f) => fs.existsSync(path.join(root, f))).map((f) => ({ file: f, text: fs.readFileSync(path.join(root, f), 'utf8') }));
  const lock = path.join(root, 'package-lock.json');
  if (fs.existsSync(lock)) out.push({ file: 'package-lock.json', text: lockNames(JSON.parse(fs.readFileSync(lock, 'utf8'))).join('\n') });
  return out;
}

function forbiddenHits(root: string): string[] {
  const srcDirs = ['packages/server/src', 'packages/dashboard/src'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const sources = [...srcDirs.flatMap(sourceFiles), path.join(root, 'docs/runbooks/self-improvement-loop-operations.md')]
    .filter((f) => fs.existsSync(f)).map((f) => ({ file: path.relative(root, f), text: fs.readFileSync(f, 'utf8') }));
  const targets = [...sources, ...configTexts(root)];
  const hits: string[] = [];
  for (const e of registry().entries.filter((x) => CLOSED.includes(x.verdict))) {
    for (const pattern of e.forbidden_code_patterns ?? []) {
      for (const t of targets) if (t.text.includes(pattern)) hits.push(`${e.id}: ${pattern} in ${t.file}`);
    }
  }
  return hits;
}

it('B29: a rejected approach cannot be rebuilt — forbidden code patterns of closed entries are absent from source and config', () => {
  expect(forbiddenHits(repo)).toEqual([]);
});

it('B29: the guard also catches forbidden patterns in package manifests, lockfile names and agent/MCP settings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, 'packages/x'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(path.join(tmp, 'packages/x/package.json'), JSON.stringify({ name: 'x', dependencies: { '@ruvector/core': '^2.4.0' } }));
    fs.writeFileSync(path.join(tmp, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ command: 'npx ruvector@latest hooks post' }] } }));
    // keys only: a pattern inside an integrity/resolved blob is not a dependency name
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/left-pad': { resolved: 'https://x/agentic-flow@alpha.tgz' } } }));
    const hits = forbiddenHits(tmp);
    expect(hits).toContain(`NE-009: @ruvector/ in ${path.join('packages', 'x', 'package.json')}`);
    expect(hits).toContain(`NE-009: ruvector@latest in ${path.join('.claude', 'settings.json')}`);
    expect(hits.some((h) => h.includes('package-lock.json'))).toBe(false);
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@ruvector/core': {} } }));
    expect(forbiddenHits(tmp)).toContain('NE-009: @ruvector/ in package-lock.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it('B29: NE-012 (ruvnet agent ecosystem) guards unpinned ruflo/claude-flow execution, its hook family and the cognitum remote MCP', () => {
  const ne12 = registry().entries.find((e) => e.id === 'NE-012');
  expect(ne12?.verdict).toBe('REJECT');
  const patterns = ne12?.forbidden_code_patterns ?? [];
  expect(patterns).toEqual(expect.arrayContaining(['claude-flow@alpha', '@claude-flow/cli@latest', 'ruflo@latest', 'hook-handler.cjs', 'cognitum.one/mcpSse']));
  expect(patterns).not.toContain('agentic-flow@alpha'); // owned by NE-009, not duplicated
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ne12-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(path.join(tmp, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: 'node .claude/helpers/hook-handler.cjs pre-bash' }] } }));
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { cognitum: { url: 'https://cognitum.one/mcpSse' } } }));
    const hits = forbiddenHits(tmp);
    expect(hits).toContain(`NE-012: hook-handler.cjs in ${path.join('.claude', 'settings.json')}`);
    expect(hits).toContain('NE-012: cognitum.one/mcpSse in .mcp.json');
    fs.mkdirSync(path.join(tmp, '.roo'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages/x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.roo/mcp.json'), JSON.stringify({ mcpServers: { mem0: { url: 'https://mcp.composio.dev/mem0/some-session' } } }));
    fs.writeFileSync(path.join(tmp, 'packages/x/package.json'), JSON.stringify({ name: 'x', devDependencies: { 'create-sparc': '^1.2.4' } }));
    const sparcHits = forbiddenHits(tmp);
    expect(sparcHits).toContain(`NE-012: mcp.composio.dev/ in ${path.join('.roo', 'mcp.json')}`);
    expect(sparcHits).toContain(`NE-012: create-sparc in ${path.join('packages', 'x', 'package.json')}`);
    fs.rmSync(path.join(tmp, '.roo'), { recursive: true });
    fs.rmSync(path.join(tmp, 'packages'), { recursive: true });
    // the federation adapter's OAuth issuer is a different host path and must not match
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ authorization_servers: ['https://auth.cognitum.one'] }));
    fs.rmSync(path.join(tmp, '.claude'), { recursive: true });
    expect(forbiddenHits(tmp)).toEqual([]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Reopen state machine: REJECT → REOPEN_CANDIDATE → PREREGISTERED_EXPERIMENT → REOPENED, never straight back. Until
 * REOPENED the verdict stays closed, so the forbidden patterns stay enforced during the evaluation.
 */
const REOPEN_STATES = ['REOPEN_CANDIDATE', 'PREREGISTERED_EXPERIMENT', 'REOPENED'];
type Reopen = { state: string; since: string; decision_ref: string; prereg_ref?: string; prereg_sha256?: string; result_ref?: string };
function reopenViolations(entries: (Entry & { reopen?: Reopen })[], root: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const r = e.reopen;
    if (!r) continue;
    if (!REOPEN_STATES.includes(r.state)) { out.push(`${e.id}: unknown reopen state ${r.state}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.since ?? '')) out.push(`${e.id}: reopen.since must be a date`);
    if (!r.decision_ref || r.decision_ref.length < 10) out.push(`${e.id}: reopen needs a decision_ref`);
    if (r.state !== 'REOPENED' && !CLOSED.includes(e.verdict)) out.push(`${e.id}: verdict must stay closed until REOPENED`);
    if (r.state !== 'REOPEN_CANDIDATE') {
      const file = r.prereg_ref ? path.join(root, r.prereg_ref.split(' ')[0]) : '';
      if (!file || !fs.existsSync(file)) out.push(`${e.id}: ${r.state} needs an existing prereg_ref`);
      else if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== r.prereg_sha256) out.push(`${e.id}: prereg_sha256 does not match ${r.prereg_ref}`);
    }
    if (r.state === 'REOPENED' && !r.result_ref) out.push(`${e.id}: REOPENED needs a result_ref`);
  }
  return out;
}

it('B29: reopening a closed entry goes through REOPEN_CANDIDATE → PREREGISTERED_EXPERIMENT → REOPENED', () => {
  expect(reopenViolations(registry().entries, repo)).toEqual([]);
  const base = { id: 'NE-900', hypothesis: 'h'.repeat(20), verdict: 'REJECT', evidence: ['x'], reopen_condition: 'c'.repeat(20) };
  const decision = { since: '2026-11-07', decision_ref: 'operator decision 2026-11-07' };
  expect(reopenViolations([{ ...base, reopen: { state: 'REOPEN_CANDIDATE', ...decision } }], repo)).toEqual([]);
  expect(reopenViolations([{ ...base, verdict: 'INCONCLUSIVE', reopen: { state: 'REOPEN_CANDIDATE', ...decision } }], repo)).toEqual(['NE-900: verdict must stay closed until REOPENED']);
  expect(reopenViolations([{ ...base, reopen: { state: 'REOPENED', ...decision } }], repo)).toEqual(['NE-900: REOPENED needs an existing prereg_ref', 'NE-900: REOPENED needs a result_ref']);
  expect(reopenViolations([{ ...base, reopen: { state: 'PREREGISTERED_EXPERIMENT', ...decision, prereg_ref: 'README.md', prereg_sha256: '0'.repeat(64) } }], repo)).toEqual(['NE-900: prereg_sha256 does not match README.md']);
  expect(reopenViolations([{ ...base, reopen: { state: 'OPEN', ...decision } }], repo)).toEqual(['NE-900: unknown reopen state OPEN']);
});

/**
 * A reopen that ends without REOPENED is not deleted: the active `reopen` block becomes a `reopen_history` record with
 * the furthest state reached, the closing decision, the evidence and the outcome. The verdict stays closed.
 */
type ReopenRecord = Reopen & { closed_on: string; closed_by: string; outcome: string; evidence_refs: string[] };
function historyViolations(entries: (Entry & { reopen_history?: ReopenRecord[] })[], root: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const h of e.reopen_history ?? []) {
      if (!REOPEN_STATES.includes(h.state) || h.state === 'REOPENED') out.push(`${e.id}: reopen_history state must be a non-final reopen state`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.closed_on ?? '') || (h.since ?? '') > (h.closed_on ?? '')) out.push(`${e.id}: reopen_history needs since <= closed_on dates`);
      if (!h.closed_by || h.closed_by.length < 10) out.push(`${e.id}: reopen_history needs closed_by`);
      if (!h.outcome || h.outcome.length < 10) out.push(`${e.id}: reopen_history needs an outcome`);
      if (!CLOSED.includes(e.verdict)) out.push(`${e.id}: a closed reopen keeps a closed verdict`);
      for (const ref of h.evidence_refs ?? []) if (!ref.startsWith('PR #') && !fs.existsSync(path.join(root, ref.split(' ')[0]))) out.push(`${e.id}: missing evidence ${ref}`);
      if (!(h.evidence_refs ?? []).length) out.push(`${e.id}: reopen_history needs evidence_refs`);
    }
  }
  return out;
}

it('B29: a reopen closed without REOPENED is kept as reopen_history with evidence, and the verdict stays closed', () => {
  expect(historyViolations(registry().entries, repo)).toEqual([]);
  const base = { id: 'NE-901', hypothesis: 'h'.repeat(20), verdict: 'REJECT', evidence: ['x'], reopen_condition: 'c'.repeat(20) };
  const rec = { state: 'REOPEN_CANDIDATE', since: '2026-11-07', decision_ref: 'operator decision 2026-11-07', closed_on: '2026-11-09',
    closed_by: 'operator decision 2026-11-09', outcome: 'REJECT stands per the prereg rule', evidence_refs: ['README.md'] };
  expect(historyViolations([{ ...base, reopen_history: [rec] }], repo)).toEqual([]);
  expect(historyViolations([{ ...base, verdict: 'INCONCLUSIVE', reopen_history: [rec] }], repo)).toEqual(['NE-901: a closed reopen keeps a closed verdict']);
  expect(historyViolations([{ ...base, reopen_history: [{ ...rec, state: 'REOPENED' }] }], repo)).toEqual(['NE-901: reopen_history state must be a non-final reopen state']);
  expect(historyViolations([{ ...base, reopen_history: [{ ...rec, evidence_refs: ['docs/nope.md'] }] }], repo)).toEqual(['NE-901: missing evidence docs/nope.md']);
  // NE-017: ORCA-001 closed 2026-11-09, REJECT stands; no active reopen, the forbidden patterns stay enforced
  const ne17 = (registry().entries as (Entry & { reopen?: Reopen; reopen_history?: ReopenRecord[] })[]).find((e) => e.id === 'NE-017');
  expect(ne17?.verdict).toBe('REJECT');
  expect(ne17?.reopen).toBeUndefined();
  expect(ne17?.reopen_history?.[0]).toMatchObject({ state: 'REOPEN_CANDIDATE', closed_on: '2026-11-09' });
  expect(ne17?.reopen_history?.[0]?.evidence_refs).toContain('docs/orca/cli-snapshot-1.4.251.md');
});

it('B29: NE-017 (Orca as runtime substrate) is REJECT and guards an Orca dependency, MCP entry or `orca serve` runtime', () => {
  const ne17 = registry().entries.find((e) => e.id === 'NE-017');
  expect(ne17?.verdict).toBe('REJECT');
  expect(ne17?.forbidden_code_patterns).toEqual(expect.arrayContaining(['stablyai/orca', 'orca serve']));
  expect(ne17?.reopen_condition).toContain('remote_maker_jobs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ne17-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, 'packages/x/src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packages/x/package.json'), JSON.stringify({ name: 'x', dependencies: { orca: 'github:stablyai/orca' } }));
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { orca: { command: 'orca serve' } } }));
    const hits = forbiddenHits(tmp);
    expect(hits).toContain(`NE-017: stablyai/orca in ${path.join('packages', 'x', 'package.json')}`);
    expect(hits).toContain('NE-017: orca serve in .mcp.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it('B29: NE-018 (ACE-001 similarity-retrieved maker context) is REJECT, cites its result, and forbids no code (the flag stays until the operator turns it off)', () => {
  const ne18 = registry().entries.find((e) => e.id === 'NE-018');
  expect(ne18?.verdict).toBe('REJECT');
  expect(ne18?.evidence).toContain('docs/research/ace/ACE-001_RESULT.md');
  for (const ref of ne18?.evidence ?? []) expect(fs.existsSync(path.join(repo, ref.split(' ')[0])), ref).toBe(true);
  expect(ne18?.forbidden_code_patterns).toEqual([]);
});
