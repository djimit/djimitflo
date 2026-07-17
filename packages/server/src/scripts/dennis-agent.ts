import { spawnSync } from 'child_process';
import path from 'path';
import { initializeDatabase } from '../database';
import { DennisAgentService } from '../services/dennis-agent-service';

function runOpenMythosGate(): { status: 'pass' | 'fail'; output: string } {
  const gate = process.env.OPENMYTHOS_SKILL_LIFECYCLE_GATE
    || '/Users/dlandman/OpenMythos/openmythos-benchmark/scripts/skill_lifecycle_gate.py';
  const result = spawnSync('python3', [gate], { encoding: 'utf8', timeout: 120_000 });
  return {
    status: result.status === 0 ? 'pass' : 'fail',
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function heartbeat() {
  const db = initializeDatabase();
  try {
    const service = new DennisAgentService(db);
    const result = service.heartbeat({
      pid: process.pid,
      cwd: process.cwd(),
      script: path.relative(process.cwd(), __filename),
    });
    const snapshot = service.readinessSnapshot();
    const gate = process.argv.includes('--openmythos-gate') ? runOpenMythosGate() : { status: 'skipped', output: '' };
    console.log(JSON.stringify({ result, snapshot, openmythos_skill_lifecycle_gate: gate }, null, 2));
  } finally {
    db.close();
  }
}

function main() {
  const intervalArg = process.argv.find((arg) => arg.startsWith('--interval-ms='));
  const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) : 0;
  heartbeat();
  if (intervalMs > 0) {
    setInterval(heartbeat, intervalMs);
  }
}

main();
