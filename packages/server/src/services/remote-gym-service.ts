import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { mineGymTasks, type GymTask } from './gym-task-miner';
import { parseSpecies } from './evolve-selection';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { infraFailing, triedTasks } from './evolution-gym-service';
import { mutantTask, type MutantTask } from './gym-mutants';
import { dreamEvolutionEnabled, ensureBaseline, genome, holdout, mutantHoldout, mutantTrialsEnabled, nextTrialAttempt, type Genome } from './genome-registry';

/**
 * Plan I1: the evolution gym on a remote compute host (the workstation: 48 threads, 125 GB, R9700) instead of the
 * 2-core VPS. The host pulls work (no inbound port): claim → it replays the task in its own docker sandbox → result.
 * Only the score comes back; nothing is pushed, reviewed or merged, exactly like the local gym. Same never-repeat
 * bookkeeping (a loop_run per attempt, keyed by species), own daily cap. EVOLUTION_GYM_REMOTE_ENABLED=true (default off).
 */
export const remoteGymEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.EVOLUTION_GYM_REMOTE_ENABLED === 'true';
export const REMOTE_GYM_SCOPE = 'gym-worker';
/**
 * RX-5 (Phase F): difficulty probe. Every GYM_TIER_PROBE_EVERY-th ordinary claim (default 4 = 25 %) is a mutant-repair task
 * at a fixed tier from GYM_TIER_PROBE_TIERS (rotating), never a holdout key, tagged gym.probe so the adaptive tier and
 * readers can tell it apart. It measures pass rate per tier before anyone changes DREAM_TRIAL_MUTANT_TIERS.
 * GYM_TIER_PROBE_ENABLED=true (default off); trials keep priority and the daily cap counts probe claims.
 */
export function tierProbe(db: Database, env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.GYM_TIER_PROBE_ENABLED !== 'true') return null;
  const tiers = String(env.GYM_TIER_PROBE_TIERS || '4,5,6').split(',').map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= 8);
  const every = Math.max(1, Number(env.GYM_TIER_PROBE_EVERY) || 4);
  if (!tiers.length) return null;
  const n = (k: string) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' ${k}`).get() as { n: number }).n; } catch { return 0; } };
  if ((n("AND json_extract(metadata, '$.gym.remote_host') IS NOT NULL") + 1) % every !== 0) return null;
  return tiers[n("AND json_extract(metadata, '$.gym.probe') = 1") % tiers.length];
}
const holdoutKeys = (db: Database): string[] => {
  try { return (db.prepare('SELECT commit_sha AS k FROM gym_holdout UNION SELECT key AS k FROM gym_mutant_holdout').all() as Array<{ k: string }>).map((r) => r.k); } catch { return []; }
};
const SAFE = /^[A-Za-z0-9._:/@-]{1,80}$/;

export type RemoteGymClaim = { runId: string; species: string; task: GymTask; genome?: { id: string; lines: string[] } } | { skipped: string };
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
    const tasks = this.mine(repo);
    // Y3: with dream evolution on, paired trial attempts on the frozen holdout come before normal replays
    let task: GymTask | undefined; let trialGenome: Genome | null = null;
    if (dreamEvolutionEnabled()) {
      ensureBaseline(this.db, now.toISOString());
      const mutants = mutantTrialsEnabled() ? mutantHoldout(this.db, (tier, tried) => mutantTask(this.db, repo, key, tried, tier), now.toISOString()) : [];
      const next = nextTrialAttempt(this.db, key, [...holdout(this.db, tasks, now.toISOString()), ...mutants.map((m) => m.commit)]);
      if (next) { task = tasks.find((t) => t.commit === next.commit) ?? mutants.find((m) => m.commit === next.commit); trialGenome = task ? genome(this.db, next.genomeId) : null; }
      if (!trialGenome) task = undefined;
    }
    let probe = false;
    if (!task) {
      const tried = triedTasks(this.db, key);
      const probeTier = tierProbe(this.db);
      if (probeTier !== null) {
        const p = mutantTask(this.db, repo, key, new Set([...tried, ...holdoutKeys(this.db)]), probeTier);
        if (p) { task = p; probe = true; }
      }
    }
    if (!task) {
      const tried = triedTasks(this.db, key);
      // Y4: the mined fix commits run out (prod 2026-10-01) — then a seeded mutant-repair task keeps the gym supplied
      task = tasks.find((t) => !tried.has(t.commit)) ?? mutantTask(this.db, repo, key, tried) ?? undefined;
    }
    if (!task) return { skipped: 'no untried task' };
    const runId = randomUUID();
    const { mutant: _mutantContent, ...stored } = task as MutantTask; // the mutant goes to the worker, not into every row
    const gymMeta = { ...stored, species: key, remote_host: host, ...(trialGenome ? { genome: trialGenome.id } : {}), ...(probe ? { probe: 1 } : {}) };
    this.db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'running', ?, ?, ?, ?)")
      .run(runId, repo, JSON.stringify({ gym: gymMeta }), now.toISOString(), now.toISOString());
    return { runId, species: key, task, ...(trialGenome ? { genome: { id: trialGenome.id, lines: trialGenome.lines } } : {}) };
  }

  record(runId: string, host: string, result: RemoteGymResult): void {
    const row = this.db.prepare("SELECT status, json_extract(metadata, '$.gym') AS gym FROM loop_runs WHERE id = ?").get(runId) as { status: string; gym: string | null } | undefined;
    const gym = row?.gym ? JSON.parse(row.gym) as GymTask & { species: string; remote_host?: string; genome?: string; probe?: number } : null;
    if (!row || !gym || gym.remote_host !== host) throw new Error('GYM_RUN_NOT_FOUND');
    if (row.status !== 'running') throw new Error('GYM_RUN_ALREADY_SETTLED');
    if (!['success', 'failure', 'discarded'].includes(result.status)) throw new Error('GYM_RESULT_INVALID');
    const reason = String(result.reason || '').slice(0, 200);
    if (result.status !== 'discarded') {
      const [species] = parseSpecies(gym.species, 1);
      this.outcomes.recordOutcome(`loop-maker:gym:${species.runtime}`, {
        success: result.status === 'success', tokensUsed: Math.max(0, Number(result.tokens) || 0), durationMs: Math.max(0, Number(result.durationMs) || 0), domain: 'gym', taskId: runId,
        ...(species.model ? { model: species.model } : {}), evidenceRefs: [`gym:${gym.commit}`, `loop_run:${runId}`, `gym_result:${reason}`, `remote:${host}`, ...(gym.genome ? [`genome:${gym.genome}`] : []), ...(gym.probe ? ['gym:probe'] : [])],
      });
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE loop_runs SET status = 'completed', updated_at = ?, metadata = json_set(metadata, '$.gym_result', json(?)) WHERE id = ?")
      .run(now, JSON.stringify({ status: result.status, reason }), runId);
  }
}
