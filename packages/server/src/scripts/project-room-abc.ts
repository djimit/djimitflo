/**
 * PR-ABC-001 runner (docs/research/project-room/PREREG.md). Nothing here touches production.
 *
 *   npx tsx packages/server/src/scripts/project-room-abc.ts freeze  --out <manifest.json> [--seed 20261126] [--repo .]
 *   npx tsx packages/server/src/scripts/project-room-abc.ts run     --manifest <m.json> --set dev|holdout --rows <rows.jsonl> [--task <id>] [--runtime codex] [--live]
 *   npx tsx packages/server/src/scripts/project-room-abc.ts analyse --manifest <m.json> --rows <rows.jsonl> --set dev|holdout
 *
 * `run` without --live only prints the schedule and the upper cost bound (no model call). With --live it runs each task-arm
 * through the real engine and runtime: an operator decision, because it spends the runtime's quota. A task-arm that already
 * has a PASS or FAIL row is skipped; an EVALUATION_ERROR may be rerun once, for every arm alike.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { analyse, armOrder, freezeManifest, manifestIntact, runArm, type AbcManifest, type AbcRow } from '../services/project-room-abc';
import { engineProfileRunner, profileRuntimeGate } from '../services/project-room';

const arg = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const readRows = (file: string): AbcRow[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AbcRow) : []);
const readManifest = (file: string): AbcManifest => { const m = JSON.parse(fs.readFileSync(file, 'utf8')) as AbcManifest; if (!manifestIntact(m)) throw new Error('PR_ABC_MANIFEST_CHANGED: the digest does not match the content'); return m; };

async function main() {
  const command = process.argv[2];
  const repo = path.resolve(arg('repo', execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()));
  if (command === 'freeze') {
    const out = arg('out'); if (!out) throw new Error('--out is required');
    if (fs.existsSync(out)) throw new Error(`PR_ABC_MANIFEST_EXISTS: ${out} is frozen; a new selection is a new registration`);
    const manifest = freezeManifest(repo, { seed: Number(arg('seed', '20261126')), check: ['npm', 'run', 'test', '-w', '@djimitflo/server', '--', '{tests}'] });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`frozen ${manifest.tasks.length} tasks (${manifest.tasks.filter((t) => t.set === 'dev').length} dev, ${manifest.tasks.filter((t) => t.set === 'holdout').length} holdout), digest ${manifest.digest}`);
    return;
  }
  const manifest = readManifest(arg('manifest')); const set = arg('set') === 'holdout' ? 'holdout' : 'dev'; const rowsFile = arg('rows');
  if (command === 'analyse') { console.log(JSON.stringify(analyse(manifest, readRows(rowsFile), set), null, 2)); return; }
  if (command !== 'run') throw new Error('usage: project-room-abc freeze | run | analyse');
  if (!rowsFile) throw new Error('--rows is required');
  const runtime = arg('runtime', 'codex'); const only = arg('task');
  const tasks = manifest.tasks.filter((t) => t.set === set && (!only || t.id === only));
  const done = readRows(rowsFile); const attempts = (task: string, arm: string) => done.filter((r) => r.task === task && r.arm === arm);
  const todo = tasks.flatMap((t) => armOrder(t.id).map((arm) => ({ t, arm }))).filter(({ t, arm }) => { const a = attempts(t.id, arm); return !a.some((r) => r.observation === 'PASS' || r.observation === 'FAIL') && a.length < 2; });
  const calls = todo.reduce((n, { arm }) => n + (arm === 'A' ? 1 : arm === 'B' ? 2 : 3), 0);
  console.error(`${todo.length} task-arm run(s) to do on ${runtime}: at most ${calls} model sessions and ${(todo.length * manifest.budget.max_tokens).toLocaleString('en')} tokens (the per-arm budget is a ceiling, not an estimate)`);
  if (!flag('live')) { for (const { t, arm } of todo) console.log(`${t.id}\t${arm}\t${t.subject}`); console.error('dry run: add --live to execute (operator decision: this spends the runtime quota)'); return; }
  const gate = profileRuntimeGate(runtime);
  if (!gate.allowed) throw new Error(gate.reason ?? 'runtime refused');
  if (execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.frozen_at_commit) console.error('note: the checkout moved since the freeze; tasks are replayed from their own commits');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-abc-'));
  process.env.PROJECT_ROOM_RUNTIME = runtime;
  for (const { t, arm } of todo) {
    const row = await runArm(manifest, t, arm, repo, { runtime, profileRunner: (db) => engineProfileRunner(db) }, work);
    fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
    console.error(`${t.id} ${arm}: ${row.observation}${row.reason ? ` (${row.reason})` : ''}`);
  }
  console.log(JSON.stringify(analyse(manifest, readRows(rowsFile), set), null, 2));
}

if (require.main === module && /project-room-abc\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
