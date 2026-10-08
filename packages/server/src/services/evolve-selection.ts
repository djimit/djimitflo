import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { rankEvolveCandidates, evolveWinner, type EvolveCandidate } from './evolve-fitness-service';
import { LoopEventService } from './loop-event-service';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { gradedContestMode, leaseGraded, leaseGradedRefs } from './graded-fitness';

/**
 * E13 steps 2–3 (docs/design/evolve-loop.md): several makers on one objective, the fittest (computed in code) wins.
 *   LOOP_EVOLVE_ENABLED=true                                  default off
 *   LOOP_EVOLVE_SPECIES=opencode@ollama/kimi-k2.6:cloud,...   extra makers as runtime[@model]; at most 2 (3 makers total)
 * Pilot scope: goals of test-gap proposals only (the lane that works end to end), or goals with metadata.evolve = true.
 */
export interface Species { runtime: string; model?: string }

/** 'runtime' or 'runtime@model', comma separated. */
export function parseSpecies(list: string | undefined, max = 2): Species[] {
  return (list || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, max).map((s) => {
    const at = s.indexOf('@');
    return at < 0 ? { runtime: s } : { runtime: s.slice(0, at), model: s.slice(at + 1) };
  });
}

export function evolveSpecies(env: NodeJS.ProcessEnv = process.env): Species[] {
  if (env.LOOP_EVOLVE_ENABLED !== 'true') return [];
  return parseSpecies(env.LOOP_EVOLVE_SPECIES);
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
  // D0: `|| null` turned a measured score of 0 into "not measured"
  try { const n = path ? Number(/"after":(\d+(?:\.\d+)?)/.exec(fs.readFileSync(path, 'utf8'))?.[1] ?? NaN) : NaN; return Number.isFinite(n) ? n : null; } catch { return null; }
}

interface LeaseRow { id: string; runtime: string; status: string; metadata: string; updated_at: string }

/** The file the goal asks for (grounding artifactPath of its proposal), or null when the goal names none. */
function goalArtifact(db: Database, runId: string): string | null {
  const row = db.prepare(`SELECT json_extract(s.grounding_json, '$.artifactPath') AS artifact FROM loop_runs r JOIN goals g ON g.id = r.goal_id
    JOIN self_improvements s ON s.id = g.improvement_id WHERE r.id = ?`).get(runId) as { artifact: string | null } | undefined;
  return row?.artifact || null;
}

function candidate(l: LeaseRow, artifact: string | null): EvolveCandidate {
  const m = JSON.parse(l.metadata || '{}') as Record<string, unknown>;
  const checks = Array.isArray(m.deterministic_checks) ? m.deterministic_checks as Array<{ name?: string; status?: string; stdout_path?: string }> : [];
  const diffLines = Number(m.diff_lines ?? 0); const maxLines = Number(m.diff_max_lines ?? 0);
  // prod 2026-10-01: a sibling that edited README.md/CONTRIBUTING.md (26 lines) beat the maker that wrote the requested test
  // (32 lines); the losing maker's reviewers were cancelled and the run regressed. A maker that did not touch the goal's
  // artifact did not do the work.
  const changed = Array.isArray(m.changed_files) ? m.changed_files as string[] : [];
  const onTarget = !artifact || changed.includes(artifact);
  return {
    makerLeaseId: l.id,
    species: typeof m.model === 'string' ? `${l.runtime}@${m.model}` : l.runtime,
    exitZero: l.status === 'completed' && Number(m.exit_status ?? 1) === 0,
    checksPassed: checks.length > 0 && checks.every((c) => c.status === 'pass' || c.status === 'skipped'),
    withinBudget: maxLines > 0 && diffLines > 0 && diffLines <= maxLines && onTarget,
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
  const artifact = goalArtifact(db, runId);
  const ranked = rankEvolveCandidates(leases.map((l) => candidate(l, artifact)));
  const current = evolveWinner(ranked);
  const events = new LoopEventService(db);
  const table = ranked.map(({ makerLeaseId, species, rank, eligible, reason, diffLines, tokens }) => ({ makerLeaseId, species, rank, eligible, reason, diffLines, tokens }));
  if (!current) {
    events.recordEvent(runId, 'evolve_no_winner', 'warning', 'Evolve: no maker passed the hard gates.', { fitness: table });
    return null;
  }
  // SI-B (GRADED_CONTEST_MODE): among makers that passed every gate, the highest graded score (SI-A kill share on the lease;
  // none = lowest) wins; a tie keeps the current rule's order. shadow logs the comparison; act decides by it.
  const contest = gradedContestMode();
  const passed = ranked.filter((r) => r.eligible);
  const graded = new Map(passed.map((r) => [r.makerLeaseId, leaseGraded(JSON.parse(leases.find((l) => l.id === r.makerLeaseId)!.metadata || '{}'))?.score ?? null]));
  let winner = current;
  if (contest !== 'off' && passed.length >= 2) {
    const gradedWinner = passed.reduce((best, r) => ((graded.get(r.makerLeaseId) ?? -1) > (graded.get(best.makerLeaseId) ?? -1) ? r : best), passed[0]);
    try {
      events.recordEvent(runId, 'contest_graded', 'info', `Graded contest (${contest}): ${gradedWinner.species} by graded score, ${current.species} by the current rule.`,
        { current_winner: current.makerLeaseId, graded_winner: gradedWinner.makerLeaseId, scores: Object.fromEntries(graded), agree: gradedWinner.makerLeaseId === current.makerLeaseId });
    } catch { /* evidence only */ }
    if (contest === 'act') winner = gradedWinner;
  }
  const reasonOf = (r: typeof ranked[number]) => winner === current ? r.reason : r.makerLeaseId === winner.makerLeaseId ? 'winner: graded score'
    : r.makerLeaseId === current.makerLeaseId ? `lost: graded ${graded.get(r.makerLeaseId) ?? 'n/a'} vs ${graded.get(winner.makerLeaseId)}` : r.reason;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of ranked) {
      const meta = r.makerLeaseId === winner.makerLeaseId
        ? `json_remove(json_set(metadata, '$.evolve', json(?)), '$.superseded_by_maker_lease_id', '$.superseded_at')`
        : `json_set(metadata, '$.evolve', json(?), '$.superseded_by_maker_lease_id', '${winner.makerLeaseId}', '$.superseded_at', '${now}')`;
      db.prepare(`UPDATE worker_leases SET metadata = ${meta}, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ rank: r.rank, species: r.species, reason: reasonOf(r) }), now, r.makerLeaseId);
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
      // SI-B act: a maker that passed every gate and lost the contest did the work — success, tagged contest:passed_lost
      const passedLost = contest === 'act' && r.eligible;
      skills.recordOutcome(`loop-maker:${loop}:${lease.runtime}`, {
        success: passedLost, tokensUsed: r.tokens ?? 0, durationMs: 0, domain: loop, taskId: runId, agentId: r.makerLeaseId,
        ...(typeof model === 'string' ? { model } : {}), evidenceRefs: [`loop_run:${runId}`, `evolve:lost_to:${winner.species}`, `evolve:reason:${reasonOf(r)}`,
          passedLost ? 'contest:passed_lost' : `evolve:lost_${r.eligible ? 'eligible' : 'ineligible'}`, ...leaseGradedRefs(JSON.parse(lease.metadata || '{}'))],
      });
    }
  } catch { /* lineage bookkeeping must never change the selection */ }
  events.recordEvent(runId, 'evolve_selected', 'info', `Evolve: ${winner.species} won out of ${ranked.length} makers.`, { winner: winner.makerLeaseId, fitness: table });
  return winner.makerLeaseId;
}
