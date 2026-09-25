import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { rankEvolveCandidates, evolveWinner, type EvolveCandidate } from './evolve-fitness-service';
import { LoopEventService } from './loop-event-service';
import { SkillEvolutionEngine } from './skill-evolution-engine';

/**
 * E13 steps 2–3 (docs/design/evolve-loop.md): several makers on one objective, the fittest (computed in code) wins.
 *   LOOP_EVOLVE_ENABLED=true                                  default off
 *   LOOP_EVOLVE_SPECIES=opencode@ollama/kimi-k2.6:cloud,...   extra makers as runtime[@model]; at most 2 (3 makers total)
 * Pilot scope: goals of test-gap proposals only (the lane that works end to end), or goals with metadata.evolve = true.
 */
export interface Species { runtime: string; model?: string }

export function evolveSpecies(env: NodeJS.ProcessEnv = process.env): Species[] {
  if (env.LOOP_EVOLVE_ENABLED !== 'true') return [];
  return (env.LOOP_EVOLVE_SPECIES || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2).map((s) => {
    const at = s.indexOf('@');
    return at < 0 ? { runtime: s } : { runtime: s.slice(0, at), model: s.slice(at + 1) };
  });
}

export function evolveEligible(db: Database, goalId: string): boolean {
  const row = db.prepare(`SELECT g.metadata, s.evidence_refs_json FROM goals g LEFT JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?`)
    .get(goalId) as { metadata: string | null; evidence_refs_json: string | null } | undefined;
  if (!row) return false;
  try { if (JSON.parse(row.metadata || '{}').evolve === true) return true; } catch { /* not json */ }
  return /"(test-gap|mutation-gap):/.test(row.evidence_refs_json || ''); // M2: the mutation lane has a continuous fitness
}

/** M2: the `after` score from the mutation-gain check's JSON line (scripts/mutation-gain.mjs), or null when not measured. */
export function mutationScoreOf(checks: Array<{ name?: string; stdout_path?: string }>): number | null {
  const path = checks.find((c) => c.name === 'test:mutation:grounded')?.stdout_path;
  try { return path ? Number(/"after":(\d+(?:\.\d+)?)/.exec(fs.readFileSync(path, 'utf8'))?.[1] ?? NaN) || null : null; } catch { return null; }
}

interface LeaseRow { id: string; runtime: string; status: string; metadata: string; updated_at: string }

function candidate(l: LeaseRow): EvolveCandidate {
  const m = JSON.parse(l.metadata || '{}') as Record<string, unknown>;
  const checks = Array.isArray(m.deterministic_checks) ? m.deterministic_checks as Array<{ name?: string; status?: string; stdout_path?: string }> : [];
  const diffLines = Number(m.diff_lines ?? 0); const maxLines = Number(m.diff_max_lines ?? 0);
  return {
    makerLeaseId: l.id,
    species: typeof m.model === 'string' ? `${l.runtime}@${m.model}` : l.runtime,
    exitZero: l.status === 'completed' && Number(m.exit_status ?? 1) === 0,
    checksPassed: checks.length > 0 && checks.every((c) => c.status === 'pass' || c.status === 'skipped'),
    withinBudget: maxLines > 0 && diffLines > 0 && diffLines <= maxLines,
    mutationScore: mutationScoreOf(checks),
    diffLines,
    tokens: Number((m.runtime_usage as { total_tokens?: unknown } | undefined)?.total_tokens) || null,
    finishedAt: String(m.completed_at ?? l.updated_at),
  };
}

/**
 * Ranks the given makers of a run, keeps the winner as the only non-superseded maker and cancels the losers' reviewer
 * leases, so the existing checker → security → verify flow runs for the winner only. Returns the winner's lease id, or
 * null when no maker passes the hard gates (then nothing changes and the run fails like a single-maker run).
 */
export function selectEvolveWinner(db: Database, runId: string, makerLeaseIds: string[]): string | null {
  const leases = makerLeaseIds.map((id) => db.prepare('SELECT id, runtime, status, metadata, updated_at FROM worker_leases WHERE id = ?').get(id) as LeaseRow | undefined)
    .filter((l): l is LeaseRow => Boolean(l));
  const ranked = rankEvolveCandidates(leases.map(candidate));
  const winner = evolveWinner(ranked);
  const events = new LoopEventService(db);
  const table = ranked.map(({ makerLeaseId, species, rank, eligible, reason, diffLines, tokens }) => ({ makerLeaseId, species, rank, eligible, reason, diffLines, tokens }));
  if (!winner) {
    events.recordEvent(runId, 'evolve_no_winner', 'warning', 'Evolve: no maker passed the hard gates.', { fitness: table });
    return null;
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of ranked) {
      const meta = r.makerLeaseId === winner.makerLeaseId
        ? `json_remove(json_set(metadata, '$.evolve', json(?)), '$.superseded_by_maker_lease_id', '$.superseded_at')`
        : `json_set(metadata, '$.evolve', json(?), '$.superseded_by_maker_lease_id', '${winner.makerLeaseId}', '$.superseded_at', '${now}')`;
      db.prepare(`UPDATE worker_leases SET metadata = ${meta}, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ rank: r.rank, species: r.species, reason: r.reason }), now, r.makerLeaseId);
      if (r.makerLeaseId !== winner.makerLeaseId) {
        db.prepare(`UPDATE worker_leases SET status = 'cancelled', updated_at = ? WHERE loop_run_id = ? AND role IN ('checker', 'security_checker')
          AND status = 'prepared' AND json_extract(metadata, '$.maker_lease_id') = ?`).run(now, runId, r.makerLeaseId);
      }
    }
  })();
  // N7 lineage: a species that lost the head-to-head is an outcome too (success 0), or the bandit would only ever see
  // winners. The winner's own outcome is recorded when the run finishes (loop-daemon 9a'').
  try {
    const loop = (db.prepare('SELECT loop_name FROM loop_runs WHERE id = ?').get(runId) as { loop_name: string } | undefined)?.loop_name ?? 'unknown';
    const skills = new SkillEvolutionEngine(db);
    for (const r of ranked.filter((x) => x.makerLeaseId !== winner.makerLeaseId)) {
      const lease = leases.find((l) => l.id === r.makerLeaseId)!;
      // a maker that never finished (still prepared/running) did not compete: no fitness verdict, only an event
      if (lease.status !== 'completed' && lease.status !== 'failed') continue;
      const model = (JSON.parse(lease.metadata || '{}') as { model?: unknown }).model;
      skills.recordOutcome(`loop-maker:${loop}:${lease.runtime}`, {
        success: false, tokensUsed: r.tokens ?? 0, durationMs: 0, domain: loop, taskId: runId, agentId: r.makerLeaseId,
        ...(typeof model === 'string' ? { model } : {}), evidenceRefs: [`loop_run:${runId}`, `evolve:lost_to:${winner.species}`, `evolve:reason:${r.reason}`],
      });
    }
  } catch { /* lineage bookkeeping must never change the selection */ }
  events.recordEvent(runId, 'evolve_selected', 'info', `Evolve: ${winner.species} won out of ${ranked.length} makers.`, { winner: winner.makerLeaseId, fitness: table });
  return winner.makerLeaseId;
}
