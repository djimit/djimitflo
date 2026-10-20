import { expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

/** Where a forbidden dependency, hook command or MCP entry would land: package manifests, lockfile names, MCP and agent settings. */
function configTexts(root: string): { file: string; text: string }[] {
  const ls = (dir: string, re: RegExp) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : []);
  const pkgDirs = fs.existsSync(path.join(root, 'packages')) ? fs.readdirSync(path.join(root, 'packages')).map((d) => path.join('packages', d, 'package.json')) : [];
  const files = ['package.json', ...pkgDirs, '.mcp.json', path.join('.vscode', 'mcp.json'), ...ls('.claude', /^settings.*\.json$/), ...ls('.opencode', /\.json$/)];
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
    // the federation adapter's OAuth issuer is a different host path and must not match
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ authorization_servers: ['https://auth.cognitum.one'] }));
    fs.rmSync(path.join(tmp, '.claude'), { recursive: true });
    expect(forbiddenHits(tmp)).toEqual([]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
