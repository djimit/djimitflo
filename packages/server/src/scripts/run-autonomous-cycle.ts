/**
 * Run one autonomous goal cycle: generate goals → execute via loop daemon.
 *
 * Usage: npx ts-node src/scripts/run-autonomous-cycle.ts
 */

import { initializeDatabase } from '../database';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { LoopService } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { SelfModelService } from '../services/self-model-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

async function main() {
  console.log('🤖 DjimFlo Autonomous Cycle');
  console.log('');

  const db = initializeDatabase();
  const swarmStatus = new SwarmStatusService(db);
  const selfModel = new SelfModelService(db);

  const concurrencyAdvisor = (): number | null => {
    try {
      const status = swarmStatus.getStatus();
      const pools = status.fleet_pools as Array<{ recommended_concurrency: number }>;
      if (!pools || pools.length === 0) return null;
      return pools.reduce((sum, p) => sum + (p.recommended_concurrency || 0), 0);
    } catch { return null; }
  };

  const loops = new LoopService(db, undefined, concurrencyAdvisor, selfModel);

  // Step 1: Generate autonomous goals
  console.log('📊 Step 1: Generating autonomous goals...');
  const generator = new AutonomousGoalGenerator(db);
  const generated = generator.generateAll();
  console.log(`   Generated: ${generated.total} goals (${generated.improvements} improvements, ${generated.security} security, ${generated.curiosity} curiosity)`);

  if (generated.total === 0) {
    console.log('   No goals to execute. Cycle complete.');
    db.close();
    return;
  }

  // Step 2: Run one daemon tick
  console.log('');
  console.log('⚡ Step 2: Running daemon tick...');
  const daemon = new LoopDaemon(db, loops);

  try {
    await daemon.tick();
    console.log('   Daemon tick complete.');
  } catch (error) {
    console.error('   Daemon tick failed:', error instanceof Error ? error.message : String(error));
  }

  // Step 3: Close learning loop for completed runs
  console.log('');
  console.log('🧠 Step 3: Closing learning loop...');
  const knowledge = new KnowledgeRuntimeService(db);
  const completedRuns = db.prepare("SELECT id FROM loop_runs WHERE status = 'completed'").all() as Array<{ id: string }>;
  let reflections = 0;
  for (const run of completedRuns) {
    try {
      const result = knowledge.closeLoop({ loop_run_id: run.id });
      if (result.status === 'closed') reflections++;
    } catch { /* skip runs that cannot be closed yet */ }
  }
  console.log(`   Closed ${reflections} learning loop(s).`);

  // Step 4: Report results
  console.log('');
  console.log('📈 Step 4: Results...');
  const goalStats = db.prepare(`
    SELECT status, COUNT(*) as c FROM goals
    WHERE metadata LIKE '%autonomous%'
    GROUP BY status
  `).all() as Array<{ status: string; c: number }>;

  for (const g of goalStats) {
    console.log(`   ${g.status}: ${g.c}`);
  }

  const runStats = db.prepare('SELECT status, COUNT(*) as c FROM loop_runs GROUP BY status').all() as Array<{ status: string; c: number }>;
  console.log('');
  console.log('   Loop runs:');
  for (const r of runStats) {
    console.log(`     ${r.status}: ${r.c}`);
  }

  daemon.stop();
  db.close();
  console.log('');
  console.log('✅ Autonomous cycle complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
