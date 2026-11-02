/**
 * ASG-001 mechanism pilot (scripted/mock agents, no model call).
 *   npx tsx packages/server/src/scripts/asg-001-pilot.ts [--out docs/research/asg-001/pilot] [--seed 20261024] [--repetitions 1] [--agent scripted]
 * Writes manifest.json (provenance), rows.jsonl (one row per run) and analysis.json into --out. Workspaces live in a temp dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { runPilot } from '../services/asg/harness/run';
import { analyse } from '../services/asg/harness/analyse';

const arg = (name: string, dflt: string): string => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const repoRoot = path.resolve(__dirname, '../../../..');
const out = path.resolve(arg('out', path.join(repoRoot, 'docs/research/asg-001/pilot')));
const seed = Number(arg('seed', '20261024')); const repetitions = Number(arg('repetitions', '1'));
// a model-backed run is not authorised and its agent port is not built (RESULTS.md §model-backed run): fail closed
const agent = arg('agent', 'scripted');
if (agent !== 'scripted') {
  console.error(`ASG-001: --agent ${agent} is not available. The model-backed run needs an operator authorisation and the async model AgentPort listed in docs/research/asg-001/RESULTS.md.`);
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-001-'));
const git = (args: string[]): string | null => { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch { return null; } };
const prereg = path.join(repoRoot, 'docs/research/asg-001/PREREG.md');
try {
  const { manifest, rows } = runPilot({ root: tmp, seed, repetitions });
  const full = {
    ...manifest, git_head: git(['rev-parse', 'HEAD']), git_dirty: (git(['status', '--porcelain', '--', 'packages/server/src/services/asg']) ?? '') !== '',
    prereg_sha256: fs.existsSync(prereg) ? createHash('sha256').update(fs.readFileSync(prereg)).digest('hex') : null,
    command: `npx tsx packages/server/src/scripts/asg-001-pilot.ts --seed ${seed} --repetitions ${repetitions}`,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(full, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'analysis.json'), `${JSON.stringify(analyse(rows), null, 2)}\n`);
  console.log(`ASG-001 pilot: ${rows.length} runs → ${out}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
