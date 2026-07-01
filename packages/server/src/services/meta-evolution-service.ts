import type { Database } from 'better-sqlite3';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { swarmEventBus } from './swarm-event-bus';

/**
 * G32: MetaEvolutionService — periodic self-evaluation of the swarm's performance.
 *
 * Evaluates: planner accuracy, rule accuracy, capability usage.
 * Prunes: dormant capabilities (0 runs in 30 days), demotes bad rules (≥3 contradictions).
 * Emits a `meta_evolution` event on the SSE stream with the evaluation report.
 */

interface EvaluationReport {
  timestamp: string;
  planner_accuracy: number;
  rule_count: number;
  contradicted_rules: number;
  total_capabilities: number;
  dormant_capabilities: number;
  pruned: number;
  demoted_rules: number;
  synthesized_contracts: number;
}

export class MetaEvolutionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;

  constructor(
    private db: Database,
    private intelligence: SwarmIntelligenceService,
    opts: { intervalMs?: number } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? (Number(process.env.META_EVOLUTION_INTERVAL_MS) || 3600_000);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Run a single evaluation cycle.
   */
  evaluate(): EvaluationReport {
    const now = new Date().toISOString();

    // 1. Planner accuracy: % of maker leases that completed successfully.
    const totalMakers = this.db.prepare('SELECT COUNT(*) as c FROM worker_leases WHERE role = \'maker\'').get() as { c: number };
    const completedMakers = this.db.prepare('SELECT COUNT(*) as c FROM worker_leases WHERE role = \'maker\' AND status = \'completed\'').get() as { c: number };
    const plannerAccuracy = totalMakers.c > 0 ? completedMakers.c / totalMakers.c : 0;

    // 2. Rule accuracy: count contradicted rules.
    const totalRules = this.db.prepare('SELECT COUNT(*) as c FROM swarm_claims WHERE claim_type = \'memory\'').get() as { c: number };
    const contradicted = this.db.prepare('SELECT COUNT(*) as c FROM swarm_claims WHERE status = \'contradicted\'').get() as { c: number };

    // 3. Capability usage: find dormant capabilities (0 runs in 30 days).
    const caps = this.intelligence.listCapabilities().filter(c => c.status === 'validated' || c.status === 'candidate');
    let dormantCount = 0;
    let pruned = 0;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    for (const cap of caps) {
      const recentRuns = this.db.prepare('SELECT COUNT(*) as c FROM worker_leases WHERE capability_id = ? AND created_at > ?').get(cap.id, thirtyDaysAgo) as { c: number };
      if (recentRuns.c === 0 && cap.status === 'validated') {
        dormantCount++;
        // Prune: deprecate dormant validated capabilities.
        this.db.prepare('UPDATE swarm_capabilities SET status = ?, updated_at = ? WHERE id = ?')
          .run('deprecated', now, cap.id);
        pruned++;
        swarmEventBus.emit('capability_transition', {
          capability_id: cap.id, old_status: 'validated', new_status: 'deprecated',
          reason: 'dormant: 0 runs in 30 days',
        });
      }
    }

    // 4. Demote bad rules: rules with ≥3 contradictions.
    let demotedRules = 0;
    try {
      const badRules = this.db.prepare('SELECT id FROM swarm_claims WHERE status = \'contradicted\' AND claim_type = \'memory\'').all() as Array<{ id: string }>;
      for (const rule of badRules) {
        const contradictions = this.db.prepare('SELECT COUNT(*) as c FROM swarm_claims WHERE contradicts_ref = ?').get(rule.id) as { c: number };
        if (contradictions.c >= 3) {
          // Demote: set trust to 0.3 (via metadata update)
          const existing = this.db.prepare('SELECT metadata FROM swarm_claims WHERE id = ?').get(rule.id) as { metadata: string };
          const meta = JSON.parse(existing.metadata || '{}');
          meta.demoted = true;
          meta.demoted_at = now;
          meta.demoted_reason = `${contradictions.c} contradictions`;
          this.db.prepare('UPDATE swarm_claims SET metadata = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(meta), now, rule.id);
          demotedRules++;
        }
      }
    } catch { /* best-effort */ }

    // G44: Synthesize draft loop contracts from recurring gaps
    let synthesizedContracts = 0;
    const recurringGaps = this.db.prepare(`
      SELECT subject_ref, COUNT(*) as freq FROM swarm_claims
      WHERE claim_type = 'capability' AND created_at > datetime('now', '-30 days')
      GROUP BY subject_ref HAVING freq >= 3
    `).all() as Array<{ subject_ref: string; freq: number }>;

    for (const gap of recurringGaps) {
      const existing = this.db.prepare('SELECT id FROM swarm_capabilities WHERE id = ?').get(`loop-contract-${gap.subject_ref}`);
      if (existing) continue;

      const draftContract = {
        name: 'research-loop',
        title: `Research: ${gap.subject_ref}`,
        description: `Auto-generated loop contract for recurring gap: ${gap.subject_ref}`,
        trigger: ['capability_gap'],
        context_sources: ['okf_memory', 'qdrant_knowledge'],
        actions_allowed: ['search', 'read', 'synthesize', 'cite'],
        actions_forbidden: ['deploy', 'merge', 'push'],
        verification: ['source_quality', 'logical_consistency'],
      };

      const metaJson = JSON.stringify({
        draft_loop_contract: draftContract,
        synthesized_from: gap.subject_ref,
        gap_frequency: gap.freq,
      });
      this.db.prepare(
        "INSERT OR IGNORE INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, 'deterministic_harness', 'meta-evolution', '0.1.0', 'draft', 'low', 'none', 'none', '[\"spawn_runtime_worker\"]', '[\"deploy\"]', '[\"proof:test\"]', 0, 0.5, '{}', 'demote_on_fail', ?, datetime('now'), datetime('now'))"
      ).run(`loop-contract-${gap.subject_ref}`, metaJson);

      synthesizedContracts++;
    }

    const report: EvaluationReport = {
      timestamp: now,
      planner_accuracy: plannerAccuracy,
      rule_count: totalRules.c,
      contradicted_rules: contradicted.c,
      total_capabilities: caps.length,
      dormant_capabilities: dormantCount,
      pruned,
      demoted_rules: demotedRules,
      synthesized_contracts: synthesizedContracts,
    };

    swarmEventBus.emit('convergence', {
      meta_evolution: 'evaluation_complete',
      ...report,
    });

    return report;
  }
}
