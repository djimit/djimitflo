// SEC-F1 shared helpers (docs/research/eco/SEC-F1_PROTOCOL.md, amendment 1): item order, the blind item view the
// runner may see, the throwaway checkout, the five pre-registered regex rules and output-path guards.
// Zero dependencies. Never installs anything and never runs a script from a checkout: only `git` is executed here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ITEMS_DIR = path.join(REPO_ROOT, 'docs/research/eco/sec-f1');
/** sha256(JSON.stringify(CHECKER_INSTRUCTIONS)) registered in the protocol (origin/main 89db35c6). */
export const CHECKER_INSTRUCTIONS_SHA256 = 'dd10149499c04656458c50fda4324d0181b5bcfe10da5a816273f50489aab4ac';
export const ORDER_SEED = 20261021;
export const TOKEN_CAP = 6_000_000;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Protocol "Deterministic baseline" rule 3, transcribed from the table (a test compares them with the protocol text). */
export const RULES = Object.freeze({
  R1: /(?:JSON\.stringify|console\.\w+)\(\s*process\.env\s*\)|\b(?:fetch|axios|https?\.request)\b.*process\.env/,
  R2: /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\([^)]*(?:\$\{|['"\x60]\s*\+)|['"](?:sh|bash)['"]\s*,\s*\[\s*['"]-c['"]/,
  R3: /(?:\.\.[\/\\]){2,}|['"\x60]\.\.['"\x60]\s*,\s*['"\x60]\.\.['"\x60]|os\.homedir\(\)|\/etc\/(?:passwd|shadow)/,
  R4: /process\.env\.[A-Z0-9_]*(?:BYPASS|DISABLE_AUTH|SKIP_AUTH|NO_AUTH|INSECURE)[A-Z0-9_]*/,
  R5: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w+|Script|compileFunction)\b|\brequire\s*\(\s*[^'"\x60\s)]/,
});

/** The added lines of a unified diff (the `+` lines, without the `+++ ` file headers), without the leading `+`. */
export const addedLines = (patch) => String(patch).split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++ ')).map((l) => l.slice(1));

/** Which of R1..R5 match at least one added line. */
export function regexHits(patch) {
  const lines = addedLines(patch);
  return Object.keys(RULES).filter((r) => lines.some((l) => RULES[r].test(l)));
}

/** Amendment 1: regex-visible = at least one of R1..R5 matches an added line (computed, never authored). */
export const regexVisible = (patch) => regexHits(patch).length > 0;

/** Mulberry32 PRNG (the common public-domain form). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Protocol "Order": Fisher-Yates (from the end) over the sorted ids with Mulberry32(seed). */
export function runOrder(ids, seed = ORDER_SEED) {
  const out = [...ids].sort();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The only manifest fields the runner may see. Labels (variant, class, advisory, CWE, wording flag, source) never pass. */
export const BLIND_FIELDS = Object.freeze(['id', 'repo', 'base_sha', 'files', 'patch_sha256', 'finding', 'finding_sha256']);
export function blindItems(manifest) {
  return manifest.items.map((i) => Object.fromEntries(BLIND_FIELDS.map((k) => [k, i[k]])));
}

export function readManifest(itemsDir) {
  return JSON.parse(fs.readFileSync(path.join(itemsDir, 'manifest.json'), 'utf8'));
}

/** The item's patch, verified against its registered hash (a drifted item aborts the run). */
export function readPatch(itemsDir, item) {
  const patch = fs.readFileSync(path.join(itemsDir, 'items', `${item.id}.patch`), 'utf8');
  if (sha256(patch) !== item.patch_sha256) throw new Error(`SEC_F1_PATCH_HASH_MISMATCH ${item.id}`);
  return patch;
}

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Outputs never go into the repo, the items dir, /data or a database file. */
export function assertSafeOutput(p, { repoRoot = REPO_ROOT, itemsDir } = {}) {
  const abs = path.resolve(p);
  if (isInside(abs, repoRoot)) throw new Error(`SEC_F1_OUTPUT_IN_REPO ${abs}`);
  if (itemsDir && isInside(abs, itemsDir)) throw new Error(`SEC_F1_OUTPUT_IN_ITEMS ${abs}`);
  if (isInside(abs, '/data')) throw new Error(`SEC_F1_OUTPUT_IN_DATA ${abs}`);
  if (/\.(sqlite3?|db)(-wal|-shm)?$/i.test(abs)) throw new Error(`SEC_F1_OUTPUT_IS_DB ${abs}`);
  return abs;
}

export function assertCheckerInstructions(instructions, expected = CHECKER_INSTRUCTIONS_SHA256) {
  const actual = sha256(JSON.stringify(instructions));
  if (actual !== expected) throw new Error(`SEC_F1_PROMPT_HASH_MISMATCH expected ${expected} got ${actual}`);
  return actual;
}

// ── throwaway checkout ──────────────────────────────────────────────────────

/** git with hooks, fsmonitor and LFS smudging off, never a pager or prompt; the checkout's own config runs nothing. */
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false'];
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_PAGER: 'cat' });
export function git(args, opts = {}) {
  return execFileSync('git', [...GIT_SAFE, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(), ...opts });
}

/** A shallow (depth 1) bare cache of `repo` holding `sha`, fetched only when missing. The only network step. */
export function ensureBase(workDir, repo, sha) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SEC_F1_BAD_ITEM ${repo}@${sha}`);
  const bare = path.join(workDir, 'git', `${repo.replace('/', '__')}.git`);
  if (!fs.existsSync(path.join(bare, 'HEAD'))) { fs.mkdirSync(path.dirname(bare), { recursive: true }); git(['init', '-q', '--bare', bare]); }
  try { git(['--git-dir', bare, 'cat-file', '-e', `${sha}^{commit}`]); }
  catch { git(['--git-dir', bare, 'fetch', '-q', '--no-tags', '--depth', '1', `https://github.com/${repo}.git`, sha]); }
  git(['--git-dir', bare, 'update-ref', `refs/heads/secf1-${sha}`, sha]);
  return bare;
}

/**
 * Protocol "Repo under review": `git clone --shared` of the cached repo, detached at `base_sha`, the patch applied to
 * the working tree only (the index is never touched), so the prod workingTreeDiff renders it as it would a maker's change.
 */
export function prepareCheckout(workDir, item, patch) {
  const bare = ensureBase(workDir, item.repo, item.base_sha);
  const dir = path.join(workDir, 'co', item.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(['clone', '-q', '--shared', '--no-checkout', bare, dir]);
  git(['-C', dir, 'checkout', '-q', '--detach', item.base_sha]);
  const patchFile = path.join(workDir, 'co', `${item.id}.patch`);
  fs.writeFileSync(patchFile, patch);
  git(['-C', dir, 'apply', '--check', patchFile]);
  git(['-C', dir, 'apply', patchFile]);
  fs.rmSync(patchFile, { force: true });
  return dir;
}

/** The sorted +/- lines of a diff: equal for the registered patch and the rendered working-tree diff. */
export const changedLineSet = (diff) => String(diff).split('\n')
  .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).sort();
export const sameChange = (a, b) => JSON.stringify(changedLineSet(a)) === JSON.stringify(changedLineSet(b));

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`unknown option ${a}`);
    if (spec[key] === 'flag') out[key] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); out[key] = argv[++i]; }
  }
  return out;
}

export const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
