/**
 * checker-recall: does the automated checker catch a planted defect? (prod 2026-11-22: the opencode checker accepted 479
 * of 496 makers in 60 days, 96.6 % — that says nothing about what it would have caught.)
 *
 * Case pairs come from the repository's own history: a merged commit that modifies one service file is the CLEAN change
 * (task = its subject); the DEFECT twin is the same change plus ONE seeded mutation (gym-mutants: flipped comparison or
 * boolean, swapped && / ||, off-by-one) elsewhere in that file — a behaviour change the task never asked for. Each case
 * gets the real checker prompt (LoopService.buildCheckerPrompt) over a detached worktree, with every check shown green.
 *
 *   npx tsx packages/server/src/scripts/checker-recall.ts [--n 30] [--seed 1] [--out <dir>] [--cmd '<shell command>']
 *
 * Without --cmd it only writes the prompts (dry run, no model call). With --cmd the command runs once per case in the
 * case's worktree, prompt on stdin and its path in place of {prompt_file}; stdout is parsed with the production verdict
 * parser. Offline: an in-memory database, no production access, no flag. Run it where the checker runtime is logged in.
 * ponytail: a surviving mutant can be equivalent (no behaviour change); rare for these operators, so recall is a floor.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { mutate, rng } from '../services/gym-mutants';
import { wilson } from '../services/evolution-estimators';

export interface RecallCase { id: string; label: 'clean' | 'defect'; sha: string; file: string; task: string; content: string }
export interface RecallRow { id: string; label: 'clean' | 'defect'; verdict: string | null }

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const SERVICE_RE = /^packages\/server\/src\/services\/[^/]+\.ts$/;

/** Up to n clean/defect pairs from the newest commits that modify exactly one service file in at most `maxLines` changed lines. */
export function buildCases(repo: string, n: number, seed: number, maxLines = 120): RecallCase[] {
  const cases: RecallCase[] = [];
  const log = git(repo, 'log', '--no-merges', '-n', '2000', '--format=%H%x09%s', '--', 'packages/server/src/services').split('\n').filter(Boolean);
  for (const line of log) {
    if (cases.length >= n * 2) break;
    const [sha, task] = line.split('\t');
    const stat = git(repo, 'show', '--numstat', '--format=', sha).split('\n').filter(Boolean).map((l) => l.split('\t'));
    const services = stat.filter(([, , f]) => SERVICE_RE.test(f));
    if (services.length !== 1 || stat.reduce((sum, [a, d]) => sum + (Number(a) || 0) + (Number(d) || 0), 0) > maxLines) continue;
    const file = services[0][2];
    let content: string;
    try { git(repo, 'cat-file', '-e', `${sha}^:${file}`); content = git(repo, 'show', `${sha}:${file}`); } catch { continue; } // added or deleted file
    const base = git(repo, 'show', `${sha}^:${file}`).split('\n');
    // the planted line must lie outside the commit's own change, so the defect is a separate hunk the task did not ask for
    const untouched = new Set(base);
    let defect: string | null = null;
    for (let attempt = 0; attempt < 20 && !defect; attempt++) {
      const m = mutate(content, 1, rng(seed + cases.length * 31 + attempt));
      const before = content.split('\n');
      if (m && m.split('\n').every((l, i) => l === before[i] || untouched.has(before[i]))) defect = m;
    }
    if (!defect) continue;
    const short = sha.slice(0, 10);
    cases.push({ id: `${short}-clean`, label: 'clean', sha, file, task, content }, { id: `${short}-defect`, label: 'defect', sha, file, task, content: defect });
  }
  // interleave by seed so a reviewer run never sees all clean cases first
  const random = rng(seed);
  return cases.map((c) => ({ c, k: random() })).sort((a, b) => a.k - b.k).map(({ c }) => c);
}

/**
 * recall = defects not accepted / defects with a verdict; false_reject = clean changes not accepted / clean with a verdict.
 * A case without a parsed verdict is unknown: counted, never scored. Rates are null when nothing was scored.
 */
export function summarise(rows: RecallRow[]) {
  const side = (label: RecallRow['label']) => {
    const scored = rows.filter((r) => r.label === label && r.verdict !== null);
    const k = scored.filter((r) => r.verdict !== 'accepted').length;
    return { n: scored.length, not_accepted: k, rate: scored.length ? +(k / scored.length).toFixed(4) : null, ci95: scored.length ? wilson(k, scored.length) : null,
      unknown: rows.filter((r) => r.label === label && r.verdict === null).length };
  };
  const recall = side('defect'); const false_reject = side('clean');
  return { recall, false_reject,
    // a checker that rejects everything has recall 1: what it can tell apart is the difference
    discrimination: recall.rate !== null && false_reject.rate !== null ? +(recall.rate - false_reject.rate).toFixed(4) : null,
    note: 'not_accepted = any verdict but accepted (the production gate passes only accepted); unknown = no verdict parsed, not scored' };
}

/** The production checker prompt for one case, over a detached worktree at the commit's parent with the case applied. */
export function casePrompt(loops: LoopService, repo: string, c: RecallCase, dir: string): { worktree: string; prompt: string } {
  const worktree = path.join(dir, c.id);
  git(repo, 'worktree', 'add', '--detach', '--force', worktree, c.sha);
  git(worktree, 'reset', '-q', `${c.sha}^`); // the whole commit becomes the working-tree change
  fs.writeFileSync(path.join(worktree, c.file), c.content);
  const packet = path.join(dir, `${c.id}.packet.json`);
  fs.writeFileSync(packet, JSON.stringify({ finding: { type: 'change_request', file: c.file, message: c.task }, expected_artifacts: ['diff'] }, null, 2));
  const lease = (id: string, role: string, metadata: Record<string, unknown>) => ({ id, role, worktree_path: worktree, metadata });
  const checks = ['test:changed', 'lint', 'type-check'].map((name) => ({ name, status: 'pass', exit_status: 0 }));
  const prompt = loops.buildCheckerPrompt({ id: `recall-${c.id}`, loop_name: 'checker-recall' } as never,
    lease(`maker-${c.id}`, 'maker', { assignment_packet_file: packet, deterministic_checks: checks }) as never, lease(`checker-${c.id}`, 'checker', {}) as never);
  return { worktree, prompt };
}

function main() {
  const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const out = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'checker-recall-'))));
  const cmd = arg('cmd', '');
  fs.mkdirSync(out, { recursive: true });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const loops = new LoopService(db, path.join(out, 'evidence'));
  const cases = buildCases(repo, Number(arg('n', '30')), Number(arg('seed', '1')));
  const rows: RecallRow[] = [];
  for (const c of cases) {
    const { worktree, prompt } = casePrompt(loops, repo, c, out);
    const promptFile = path.join(out, `${c.id}.prompt.md`);
    fs.writeFileSync(promptFile, prompt);
    if (cmd) {
      const r = spawnSync('sh', ['-c', cmd.replaceAll('{prompt_file}', promptFile)], { cwd: worktree, input: prompt, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
      fs.writeFileSync(path.join(out, `${c.id}.stdout.txt`), r.stdout || '');
      const verdict = r.status === 0 && loops.checkerVerdictParsed(r.stdout || '') ? loops.extractCheckerVerdict(r.stdout || '') : null;
      rows.push({ id: c.id, label: c.label, verdict });
      console.error(`${c.id}: ${verdict ?? 'unknown'}`);
    }
    git(repo, 'worktree', 'remove', '--force', worktree);
  }
  const result = { pairs: cases.length / 2, cmd: cmd || null, ...(cmd ? { ...summarise(rows), rows } : { dry_run: `prompts written to ${out}; pass --cmd to measure` }) };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module && /checker-recall\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) main();
