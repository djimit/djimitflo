/**
 * `npm run demo:proof` — seeds the DB with visible swarm state via a single
 * proof run, so Mission Control (/swarm-mission-control) shows nonzero counts
 * (capabilities, panel, claims, goals, leases, traces, …) instead of an empty
 * 0-state.
 *
 * The default `mock` runtime is fully self-contained: ProofRunService writes
 * every required artifact type in one transaction with no preconditions. Use
 * `codex` or `opencode` to run a REAL (non-synthetic) closed-loop proof that
 * actually spawns the maker/checker workers through the runtime adapter — this
 * requires the corresponding CLI binary to be installed and configured.
 *
 * Usage:
 *   npm run demo:proof                          # seed one mock proof run
 *   npm run demo:proof -- seed codex            # seed one REAL codex proof run
 *   npm run demo:proof -- seed opencode         # seed one REAL opencode proof run
 *   npm run demo:proof -- seed codex --skip-permissions
 *                                               # REAL codex run with approvals/sandbox
 *                                               # bypassed (needs RUNTIME_ALLOW_SKIP_PERMISSIONS=true)
 *   npm run demo:proof -- latest                # print the latest proof-run summary
 *   npm run demo:proof -- rollback <id>
 */
import { initializeDatabase } from '../database';
import { ProofRunService } from '../services/proof-run-service';

const SUPPORTED_RUNTIMES = ['mock', 'codex', 'opencode'] as const;
type DemoRuntime = (typeof SUPPORTED_RUNTIMES)[number];

const db = initializeDatabase();

(async () => {
  const service = new ProofRunService(db);
  const command = process.argv[2] || 'seed';

  if (command === 'seed' || command === 'create') {
    // `npm run demo:proof`            -> argv[3] undefined -> mock
    // `npm run demo:proof -- seed codex` -> argv[3] = 'codex'
    const requested = process.argv[3] || 'mock';
    if (!SUPPORTED_RUNTIMES.includes(requested as DemoRuntime)) {
      process.exitCode = 1;
      console.error(`Unsupported runtime '${requested}'. Supported: ${SUPPORTED_RUNTIMES.join(', ')}.`);
      return;
    }
    const runtime = requested as DemoRuntime;
    const isReal = runtime !== 'mock';
    const skipPermissions = process.argv.includes('--skip-permissions');
    if (isReal) {
      const bypassNote = skipPermissions
        ? ' with approvals/sandbox bypass requested'
        : '';
      console.log(`⏳ Running a REAL ${runtime} proof run (spawns maker/checker workers)${bypassNote}…`);
      if (skipPermissions && process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS !== 'true') {
        console.warn('⚠️  --skip-permissions requested but RUNTIME_ALLOW_SKIP_PERMISSIONS is not "true"; bypass will NOT be applied.');
      }
    }
    const summary = await service.create({ runtime, skip_permissions: skipPermissions });
    console.log(`✅ Seeded a ${runtime}-runtime proof run into the local database.\n`);
    console.log(`Proof run : ${summary.id}`);
    console.log(`Status    : ${summary.passed ? 'passed (all minimums met)' : 'incomplete'}`);
    console.log(`Rollback  : ${summary.rollback_safe ? 'safe' : 'blocked'}\n`);
    console.log('Artifact counts:');
    for (const [key, value] of Object.entries(summary.counts).sort()) {
      const minimum = summary.minimums[key] ?? 0;
      const mark = value >= minimum ? '✓' : '✗';
      console.log(`  ${mark} ${key.padEnd(18)} ${value}${minimum ? ` / ${minimum} required` : ''}`);
    }
    console.log('\nNarrative:');
    for (const [index, line] of summary.narrative.entries()) {
      console.log(`  ${index + 1}. ${line}`);
    }
    console.log('\n→ Open the dashboard at /swarm-mission-control to see the seeded state.');
    console.log('→ Roll back with: npm run demo:proof -- rollback ' + summary.id);
  } else if (command === 'latest') {
    const latest = service.latest();
    if (!latest) {
      process.exitCode = 1;
      console.error('No proof run found. Run `npm run demo:proof` first.');
    } else {
      console.log(JSON.stringify(latest, null, 2));
    }
  } else if (command === 'rollback') {
    const id = process.argv[3];
    if (!id) {
      process.exitCode = 1;
      console.error('Usage: npm run demo:proof -- rollback <proof-run-id>');
    } else {
      console.log(JSON.stringify(service.rollback(id), null, 2));
    }
  } else {
    process.exitCode = 1;
    console.error('Usage: npm run demo:proof -- [seed [mock|codex|opencode]|latest|rollback <proof-run-id>]');
  }
})().finally(() => {
  db.close();
});