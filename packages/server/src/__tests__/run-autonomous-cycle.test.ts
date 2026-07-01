import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SecurityScanningAgent } from '../services/security-scanning-agent';
import { EpistemicUncertaintyService } from '../services/epistemic-uncertainty-service';
import { LoopService } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { SelfModelService } from '../services/self-model-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  new SelfImprovementService(db);
  new SecurityScanningAgent(db);
  new EpistemicUncertaintyService(db);
});

afterEach(() => {
  db?.close();
});

describe('Autonomous Cycle Integration', () => {
  it('generates and executes goals end-to-end', async () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-1', 'bug_fix', 'Fix auth', 'Fix auth bug', 'security', 'reflection', 'proposed', 0.95)
    `).run();

    const generator = new AutonomousGoalGenerator(db);
    const generated = generator.generateAll();
    expect(generated.total).toBe(1);

    const intelligence = new SwarmIntelligenceService(db);
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
    const daemon = new LoopDaemon(db, loops);

    await daemon.tick();

    const goalStats = db.prepare("SELECT status, COUNT(*) as c FROM goals WHERE metadata LIKE '%autonomous%' GROUP BY status").all() as Array<{ status: string; c: number }>;
    const completed = goalStats.find(g => g.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.c).toBeGreaterThanOrEqual(1);

    daemon.stop();
  });

  it('handles empty queue gracefully', async () => {
    const intelligence = new SwarmIntelligenceService(db);
    const swarmStatus = new SwarmStatusService(db);
    const selfModel = new SelfModelService(db);

    const concurrencyAdvisor = (): number | null => null;
    const loops = new LoopService(db, undefined, concurrencyAdvisor, selfModel);
    const daemon = new LoopDaemon(db, loops);

    await daemon.tick();

    const goalCount = db.prepare("SELECT COUNT(*) as c FROM goals").get() as { c: number };
    expect(goalCount.c).toBe(0);

    daemon.stop();
  });

  it('generates goals from multiple sources', () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-1', 'bug_fix', 'Fix A', 'Desc', 'reason', 'reflection', 'proposed', 0.95),
             ('imp-2', 'feature', 'Add B', 'Desc', 'reason', 'reflection', 'proposed', 0.8)
    `).run();

    db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, duration_ms)
      VALUES ('scan-1', 'src', 'code', '[{"severity":"high","message":"issue","location":"f.ts"}]', '{}', 100)
    `).run();

    const generator = new AutonomousGoalGenerator(db);
    const result = generator.generateAll();

    expect(result.improvements).toBe(2);
    expect(result.security).toBe(1);
    expect(result.total).toBe(3);
  });
});
