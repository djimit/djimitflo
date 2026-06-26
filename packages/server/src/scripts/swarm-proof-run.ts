import { initializeDatabase } from '../database';
import { ProofRunService } from '../services/proof-run-service';

const db = initializeDatabase();

// Headless real-runtime proofs need approval/sandbox bypass (codex/opencode otherwise
// block on interactive approval in non-interactive mode and never complete). This is
// opt-in and STILL gated by resolveSkipPermissions -> RUNTIME_ALLOW_SKIP_PERMISSIONS=true
// (defense in depth). Operator arms BOTH: `--skip-permissions` (or PROOF_RUN_SKIP_PERMISSIONS=true)
// AND `RUNTIME_ALLOW_SKIP_PERMISSIONS=true`. Worktrees are isolated outside the host repo;
// never arm this against a runtime you do not trust to run unsandboxed in its worktree.
const SKIP_PERMISSIONS_REQUESTED =
  process.argv.includes('--skip-permissions') || process.env.PROOF_RUN_SKIP_PERMISSIONS === 'true';

(async () => {
  const service = new ProofRunService(db);
  const args = process.argv.slice(2).filter((a) => a !== '--skip-permissions');
  const command = args[0] || 'create';
  const id = args[1];
  const runtime = command === 'create' ? args[1] : undefined;

  if (command === 'create') {
    const summary = await service.create({
      runtime: runtime || 'mock',
      ...(SKIP_PERMISSIONS_REQUESTED ? { skip_permissions: true } : {}),
    });
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'latest') {
    const latest = service.latest();
    if (!latest) {
      process.exitCode = 1;
      console.error('No proof run found.');
    } else {
      console.log(JSON.stringify(latest, null, 2));
    }
  } else if (command === 'rollback') {
    if (!id) {
      process.exitCode = 1;
      console.error('Usage: npm run swarm:proof -- rollback <proof-run-id>');
    } else {
      console.log(JSON.stringify(service.rollback(id), null, 2));
    }
  } else {
    process.exitCode = 1;
    console.error(
      'Usage: npm run swarm:proof -- [create <mock|codex|opencode> [--skip-permissions]|latest|rollback <proof-run-id>]',
    );
    console.error('  --skip-permissions / PROOF_RUN_SKIP_PERMISSIONS=true: request approval bypass (also needs RUNTIME_ALLOW_SKIP_PERMISSIONS=true).');
  }
})().finally(() => {
  db.close();
});
