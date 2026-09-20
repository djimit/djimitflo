/**
 * Cluster parked self-improvement proposals. Dry-run by default.
 *   node dist/scripts/cluster-proposals.js            # report only
 *   node dist/scripts/cluster-proposals.js --apply    # archive non-representatives (reversible)
 *   node dist/scripts/cluster-proposals.js --restore  # undo every archive
 */
import { initializeDatabase } from '../database';
import { createEmbeddingProvider } from '../services/embedding-provider';
import { ProposalClusteringService } from '../services/proposal-clustering-service';

async function main() {
  const db = initializeDatabase();
  const service = new ProposalClusteringService(db, { embedder: process.env.PROPOSAL_CLUSTER_EMBEDDINGS === 'off' ? undefined : createEmbeddingProvider() });
  if (process.argv.includes('--restore')) {
    console.log(`restored ${service.restore()} proposals`);
    return;
  }
  const plan = await service.plan();
  console.log(`method=${plan.method} parked=${plan.total} clusters=${plan.clusters.length} would-archive=${plan.archiveCount}`);
  for (const c of plan.clusters.slice(0, 10)) console.log(`  ${c.representativeId} <- ${c.memberIds.length} duplicates`);
  if (process.argv.includes('--apply')) console.log(`archived ${service.apply(plan)} proposals`);
  else console.log('dry-run: nothing changed (use --apply)');
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
