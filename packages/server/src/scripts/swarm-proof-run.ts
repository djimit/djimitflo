import { initializeDatabase } from '../database';
import { ProofRunService } from '../services/proof-run-service';

const db = initializeDatabase();

(async () => {
  const service = new ProofRunService(db);
  const command = process.argv[2] || 'create';
  const id = process.argv[3];
  const runtime = command === 'create' ? process.argv[3] : undefined;

  if (command === 'create') {
    const summary = await service.create({ runtime: runtime || 'mock' });
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
    console.error('Usage: npm run swarm:proof -- [create <mock|codex|opencode>|latest|rollback <proof-run-id>]');
  }
})().finally(() => {
  db.close();
});
