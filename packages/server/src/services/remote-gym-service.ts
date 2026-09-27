import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { parseSpecies } from './evolve-selection';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { infraFailing } from './evolution-gym-service';

/**
 * Plan I1: the evolution gym on a remote compute host (the workstation: 48 threads, 125 GB, R9700) instead of the
 * 2-core VPS. The host pulls work (no inbound port): claim → it replays the task in its own docker sandbox → result.
 * Only the score comes back; nothing is pushed, reviewed or merged, exactly like the local gym. Same never-repeat
 * bookkeeping (a loop_run per attempt, keyed by species), own daily cap. EVOLUTION_GYM_REMOTE_ENABLED=true (default off).
 */
export const remoteGymEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_GYM_REMOTE_ENABLED === 'true';
export const REMOTE_GYM_SCOPE = 'gym-worker';
const SAFE = /^[A-Za-z0-9._:/@-]{1,80}$/;

export type RemoteGymClaim = { runId: string; species: string; task: GymTask } | { skipped: string };
export interface RemoteGymResult { status: 'success' | 'failure' | 'discarded'; reason: string; tokens?: number; durationMs?: number }

export class RemoteGymService {
  private readonly outcomes: SkillEvolutionEngine;
  constructor(private readonly db: Database, private readonly mine: (repo: string) => GymTask[] = mineGymTasks) {
    this.outcomes = new SkillEvolutionEngine(db); // also ensures skill_outcomes exists before claim() counts it
  }

  claim(host: string, offered: string[], now = new Date()): RemoteGymClaim {
    if (!remoteGymEnabled()) return { skipped: 'disabled' };
    const repo = process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { skipped: 'no repository path' };
    if (!SAFE.test(host)) throw new Error('GYM_HOST_INVALID');
    const species = parseSpecies(offered.filter((s) => typeof s === 'string' && SAFE.test(s)).join(','), 8);
    if (!species.length) throw new Error('GYM_SPECIES_REQUIRED');
    // A host runs one attempt at a time (systemd oneshot), so its runs still 'running' at a new claim lost their report
    // (prod 2026-09-27: 'fetch failed' left f2df0beb running for good). Settle them as an infra discard — the task stays untried.
    this.db.prepare(`UPDATE loop_runs SET status = 'completed', updated_at = ?,
      metadata = json_set(metadata, '$.gym_result', json_object('status', 'discarded', 'reason', 'infra: worker lost the result (no report before its next claim)'))
      WHERE loop_name = 'evolution-gym' AND status = 'running' AND json_extract(metadata, '$.gym.remote_host') = ?`).run(now.toISOString(), host);
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const today = (this.db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND created_at >= ?").get(since) as { n: number }).n;
    if (today >= (Number(process.env.EVOLUTION_GYM_REMOTE_MAX_PER_DAY) || 24)) return { skipped: 'daily cap reached' };
    // the offered species with the fewest gym outcomes goes next
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND skill_id = ? AND COALESCE(model, '') = ?");
    const healthy = species.filter((s) => !infraFailing(this.db, s.model ? `${s.runtime}@${s.model}` : s.runtime, since));
    if (!healthy.length) return { skipped: 'every species is infra-failing' };
    const pick = healthy.map((s) => ({ s, n: (count.get(`loop-maker:gym:${s.runtime}`, s.model ?? '') as { n: number }).n })).sort((a, b) => a.n - b.n)[0].s;
    const key = pick.model ? `${pick.runtime}@${pick.model}` : pick.runtime;
    const tried = new Set((this.db.prepare("SELECT json_extract(metadata, '$.gym.commit') AS c FROM loop_runs WHERE json_extract(metadata, '$.gym.species') = ? AND COALESCE(json_extract(metadata, '$.gym_result.reason'), '') NOT LIKE 'infra:%'")
      .all(key) as Array<{ c: string | null }>).map((r) => r.c));
    const task = this.mine(repo).find((t) => !tried.has(t.commit));
    if (!task) return { skipped: 'no untried task' };
    const runId = randomUUID();
    this.db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'running', ?, ?, ?, ?)")
      .run(runId, repo, JSON.stringify({ gym: { ...task, species: key, remote_host: host } }), now.toISOString(), now.toISOString());
    return { runId, species: key, task };
  }

  record(runId: string, host: string, result: RemoteGymResult): void {
    const row = this.db.prepare("SELECT status, json_extract(metadata, '$.gym') AS gym FROM loop_runs WHERE id = ?").get(runId) as { status: string; gym: string | null } | undefined;
    const gym = row?.gym ? JSON.parse(row.gym) as GymTask & { species: string; remote_host?: string } : null;
    if (!row || !gym || gym.remote_host !== host) throw new Error('GYM_RUN_NOT_FOUND');
    if (row.status !== 'running') throw new Error('GYM_RUN_ALREADY_SETTLED');
    if (!['success', 'failure', 'discarded'].includes(result.status)) throw new Error('GYM_RESULT_INVALID');
    const reason = String(result.reason || '').slice(0, 200);
    if (result.status !== 'discarded') {
      const [species] = parseSpecies(gym.species, 1);
      this.outcomes.recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: Math.max(0, Number(result.tokens) || 0), durationMs: Math.max(0, Number(result.durationMs) || 0), domain: 'gym', taskId: runId,
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${gym.commit}`, `loop_run:${runId}`, `gym_result:${reason}`, `remote:${host}`],
      });
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE loop_runs SET status = 'completed', updated_at = ?, metadata = json_set(metadata, '$.gym_result', json(?)) WHERE id = ?")
      .run(now, JSON.stringify({ status: result.status, reason }), runId);
  }
}
