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
  // Production names its embedding model DJIMITFLO_EMBED_MODEL; the provider factory reads EMBEDDING_MODEL.
  const env = { ...process.env, EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || process.env.DJIMITFLO_EMBED_MODEL };
  const threshold = Number(process.env.PROPOSAL_CLUSTER_THRESHOLD) || undefined;
  const service = new ProposalClusteringService(db, { threshold, embedder: process.env.PROPOSAL_CLUSTER_EMBEDDINGS === 'off' ? undefined : createEmbeddingProvider(env) });
  if (process.argv.includes('--restore')) {
    console.log(`restored ${service.restore()} proposals`);
    return;
  }
  const plan = await service.plan();
  if (plan.fallbackReason) console.log(`embeddings unavailable, fell back to jaccard: ${plan.fallbackReason}`);
  console.log(`method=${plan.method} parked=${plan.total} clusters=${plan.clusters.length} would-archive=${plan.archiveCount}`);
  for (const c of plan.clusters.slice(0, 10)) console.log(`  ${c.representativeId} <- ${c.memberIds.length} duplicates`);
  if (process.argv.includes('--apply')) console.log(`archived ${service.apply(plan)} proposals`);
  else console.log('dry-run: nothing changed (use --apply)');
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
