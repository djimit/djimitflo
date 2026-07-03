/**
 * Run one autonomous goal cycle: generate goals → execute via loop daemon.
 *
 * Usage: npx ts-node src/scripts/run-autonomous-cycle.ts
 */

import { initializeDatabase } from '../database';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { LoopService } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import { OkfKnowledgeUpdater } from '../services/okf-knowledge-updater';

async function main() {
  console.log('🤖 DjimFlo Autonomous Cycle');
  console.log('');

  const db = initializeDatabase();
  const loops = new LoopService(db);

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

  // Step 3b: Expert swarm (weekly knowledge acquisition)
  console.log('');
  console.log('🎓 Step 3b: Expert swarm knowledge acquisition...');
  try {
    const orchestrator = new ExpertSwarmOrchestrator(db);
    const swarmResult = await orchestrator.dispatch({
      topic: 'DjimFlo autonomous evolution and self-improving systems',
      domains: ['software-engineering', 'artificial-intelligence', 'complexity-science'],
      maxParallel: 3,
      sources: ['wikipedia', 'arxiv'],
    });
    console.log(`   Expert swarm: score=${swarmResult.verdict.score}, confidence=${swarmResult.verdict.confidence.toFixed(2)}, knowledge_updated=${swarmResult.knowledge_updated}`);

  if (swarmResult.knowledge_updated) {
    try {
      const okfUpdater = new OkfKnowledgeUpdater(db);
      const updated = await okfUpdater.updateFromVerdict(swarmResult.topic, swarmResult.expert_answers, swarmResult.verdict);
      console.log(`   OKF knowledge updated: ${updated}`);
    } catch (error) {
      console.warn('   OKF update failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }
  } catch (error) {
    console.warn('   Expert swarm failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

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
