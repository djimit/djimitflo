import Database from 'better-sqlite3';
import { schema } from '../packages/server/src/database/schema';
import { runMigrations } from '../packages/server/src/database/migrate';
import { ExpertSwarmOrchestrator } from '../packages/server/src/services/expert-swarm-orchestrator';
import { JudgeService } from '../packages/server/src/services/judge-service';
import { SelfHealingService } from '../packages/server/src/services/self-healing-service';

interface CheckResult {
  name: string;
  passed: boolean;
  evidence: Record<string, unknown>;
}

async function main(): Promise<void> {
  const db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  const results: CheckResult[] = [];

  const judge = new JudgeService(db);
  const rejected = judge.evaluate([{
    domain: 'research',
    content: 'No knowledge found.',
    source: 'none',
    confidence: 0.1,
    evidence_refs: [],
  }]);
  results.push({
    name: 'judge rejects evidence-free output',
    passed: rejected.score === 0 && rejected.verification_status === 'unverifiable',
    evidence: { score: rejected.score, status: rejected.verification_status, verdict_id: rejected.id },
  });

  const swarm = new ExpertSwarmOrchestrator(db);
  let calls = 0;
  (swarm as any).registry = {
    getAvailable: () => ['wikipedia', 'djimitkb'],
    searchAll: async (_query: string, sources: string[]) => {
      calls++;
      if (sources.includes('wikipedia')) return [];
      return [{
        id: 'benchmark-evidence',
        content: 'Evidence recovered on the bounded fallback attempt.',
        source: 'djimitkb',
        confidence: 0.9,
        title: 'Benchmark evidence',
      }];
    },
  };
  const swarmResult = await swarm.dispatch({
    topic: 'bounded retry',
    domains: ['software-engineering'],
    sources: ['wikipedia'],
  });
  const trace = db.prepare(
    'SELECT COUNT(*) AS count FROM agent_trace_spans WHERE trace_id = ? AND parent_span_id IS NOT NULL'
  ).get(swarmResult.trace_id) as { count: number };
  results.push({
    name: 'expert swarm executes retry and records trace edges',
    passed: calls === 2 && swarmResult.retry_count === 1 && trace.count >= 3,
    evidence: { calls, retry_count: swarmResult.retry_count, trace_edges: trace.count, trace_id: swarmResult.trace_id },
  });

  db.prepare(`
    INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at)
    VALUES ('benchmark-run', 'repo-maintenance-loop', 'closed', 'running', datetime('now', '-2 hours'), datetime('now', '-2 hours'))
  `).run();
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at)
    VALUES ('benchmark-stale', 'benchmark-run', 'maker', 'mock', 'prepared', datetime('now', '-2 hours'), datetime('now', '-2 hours'))
  `).run();
  const healing = new SelfHealingService(db);
  const healed = healing.heal();
  const lease = db.prepare('SELECT status FROM worker_leases WHERE id = ?').get('benchmark-stale') as { status: string };
  const staleAction = healed.actions.find((action) => action.action === 'cancel_stale_leases');
  results.push({
    name: 'self healing mutates and verifies a stale lease',
    passed: staleAction?.result === 'success' && lease.status === 'cancelled',
    evidence: { action_result: staleAction?.result, persisted_status: lease.status },
  });

  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} ${JSON.stringify(result.evidence)}`);
  }
  const passed = results.filter((result) => result.passed).length;
  console.log(JSON.stringify({ benchmark: 'djimitflo-functional-closure', passed, total: results.length }));
  db.close();
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
