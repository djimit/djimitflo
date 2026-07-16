import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface LoopConfig {
  consolidation_interval_ms: number; decay_interval_ms: number; eval_interval_ms: number;
  consolidation_enabled: boolean; decay_enabled: boolean; eval_enabled: boolean;
  drift_check_enabled: boolean; sync_enabled: boolean; encryption_enabled: boolean;
  decay_lambda: number; archive_threshold: number; reembed_threshold: number;
  epsilon_initial: number; epsilon_decay: number; ucb_exploration_weight: number;
}

export interface LoopResult {
  loop: string; started_at: string; completed_at: string; items_processed: number; errors: string[];
}

export interface BanditArm {
  strategy: string; pulls: number; total_reward: number; mean_reward: number;
}

export class MemoryEvolutionScheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  private banditArms: BanditArm[] = [
    { strategy: 'create_from_error', pulls: 0, total_reward: 0, mean_reward: 0 },
    { strategy: 'consolidate_similar', pulls: 0, total_reward: 0, mean_reward: 0 },
    { strategy: 'distill_rule', pulls: 0, total_reward: 0, mean_reward: 0 },
    { strategy: 'backfill_trace', pulls: 0, total_reward: 0, mean_reward: 0 },
  ];
  private epsilon: number;
  private totalPulls = 0;

  constructor(private db: Database, private config: LoopConfig = {
    consolidation_interval_ms: 3600000, decay_interval_ms: 86400000, eval_interval_ms: 604800000,
    consolidation_enabled: true, decay_enabled: true, eval_enabled: true,
    drift_check_enabled: true, sync_enabled: true, encryption_enabled: true,
    decay_lambda: 0.05, archive_threshold: 0.1, reembed_threshold: 0.85,
    epsilon_initial: 0.3, epsilon_decay: 0.99, ucb_exploration_weight: 1.414,
  }) {
    this.epsilon = config.epsilon_initial;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS memory_evolution_log (id TEXT PRIMARY KEY, loop_type TEXT NOT NULL, items_processed INTEGER NOT NULL DEFAULT 0, errors_json TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, completed_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS memory_decay_state (candidate_id TEXT PRIMARY KEY, decay_factor REAL NOT NULL DEFAULT 1.0, last_accessed TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS memory_encryption_keys (agent_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS idx_mel_log_type ON memory_evolution_log(loop_type);CREATE INDEX IF NOT EXISTS idx_decay_archived ON memory_decay_state(archived);");
  }

  start(): void {
    if (this.config.consolidation_enabled) this.timers.push(setInterval(() => this.runConsolidationLoop().catch(()=>{}), this.config.consolidation_interval_ms));
    if (this.config.decay_enabled) this.timers.push(setInterval(() => this.runDecayLoop().catch(()=>{}), this.config.decay_interval_ms));
    if (this.config.eval_enabled) this.timers.push(setInterval(() => this.runEvalGateLoop().catch(()=>{}), this.config.eval_interval_ms));
    if (this.config.drift_check_enabled) this.timers.push(setInterval(() => this.runDriftCheck().catch(()=>{}), 86400000));
  }

  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async runConsolidationLoop(): Promise<LoopResult> {
    const started = new Date().toISOString(); const errors: string[] = []; let processed = 0;
    try {
      const candidates = this.db.prepare("SELECT id FROM memory_candidates WHERE status IN ('candidate','promoted') AND promotion_status != 'rejected'").all() as any[];
      const ids = candidates.map((c: any) => c.id);
      if (ids.length < 2) return this.logLoop('consolidation', 0, [], started);
      const tok = (s: string) => new Set((s||'').toLowerCase().split(/\W+/).filter(Boolean));
      const all = ids.map((id: string) => this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(id) as any);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        if (!all[i] || !all[j]) continue;
        const a = tok(all[i].title + ' ' + all[i].content), b = tok(all[j].title + ' ' + all[j].content);
        const inter = new Set([...a].filter(x => b.has(x))).size, union = new Set([...a, ...b]).size;
        if (union > 0 && inter / union > 0.85) {
          const keeper = all[i].content.length >= all[j].content.length ? all[i] : all[j];
          const victim = keeper.id === all[i].id ? all[j] : all[i];
          this.db.prepare("UPDATE memory_candidates SET metadata=json_set(COALESCE(metadata,'{}'),'$.consolidated_into',?,'$.consolidated_at',?),status='rejected',promotion_status='rejected',updated_at=? WHERE id=?").run(keeper.id, new Date().toISOString(), new Date().toISOString(), victim.id);
          processed++;
        }
      }
    } catch (e) { errors.push((e as Error).message); }
    return this.logLoop('consolidation', processed, errors, started);
  }

  async runDecayLoop(): Promise<LoopResult> {
    const started = new Date().toISOString(); const errors: string[] = []; let processed = 0;
    try {
      const candidates = this.db.prepare("SELECT * FROM memory_candidates WHERE status != 'rejected'").all() as any[];
      const now = Date.now();
      for (const c of candidates) {
        const daysSince = (now - new Date(c.created_at).getTime()) / 86400000;
        const decayFactor = Math.exp(-this.config.decay_lambda * daysSince);
        this.db.prepare("INSERT OR REPLACE INTO memory_decay_state (candidate_id,decay_factor,last_accessed,archived) VALUES (?,?,?,?)").run(c.id, decayFactor, new Date().toISOString(), decayFactor < this.config.archive_threshold ? 1 : 0);
        if (decayFactor < this.config.archive_threshold) {
          this.db.prepare("UPDATE memory_candidates SET metadata=json_set(COALESCE(metadata,'{}'),'$.archived',1,'$.decay_factor',?),status='rejected',promotion_status='rejected',updated_at=? WHERE id=?").run(decayFactor, new Date().toISOString(), c.id);
          processed++;
        }
      }
    } catch (e) { errors.push((e as Error).message); }
    return this.logLoop('decay', processed, errors, started);
  }

  async runEvalGateLoop(): Promise<LoopResult> {
    const started = new Date().toISOString(); const errors: string[] = []; let processed = 0;
    try {
      const candidates = this.db.prepare("SELECT id FROM memory_candidates WHERE status='candidate' AND promotion_status='proposed'").all() as any[];
      for (const { id } of candidates) {
        const c = this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(id) as any;
        if (!c) continue;
        const meta = JSON.parse(c.metadata || '{}');
        const daysOld = (Date.now() - new Date(c.created_at).getTime()) / 86400000;
        const disc = c.status === 'promoted' ? 0.9 : 0.5;
        const stab = meta.promoted_at ? 0.8 : 0.4;
        const nov = Math.max(0, 1 - daysOld / 30);
        const cons = meta.distilled ? 0.7 : 0.5;
        const decay = c.memory_type === 'policy_rule' ? 0.9 : 0.6;
        const composite = 0.25*disc + 0.20*stab + 0.15*nov + 0.15*cons + 0.15*decay + 0.10*0.5;
        if (composite >= 0.7 && disc >= 0.6) {
          this.db.prepare("UPDATE memory_candidates SET promotion_status='promoted',status='promoted',metadata=json_set(COALESCE(metadata,'{}'),'$.promoted_at',?,'$.promotion_reason','weekly_eval'),updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), id);
        } else if (composite < 0.3) {
          this.db.prepare("UPDATE memory_candidates SET promotion_status='rejected',status='rejected',metadata=json_set(COALESCE(metadata,'{}'),'$.rejection_reason','below_threshold'),updated_at=? WHERE id=?").run(new Date().toISOString(), id);
        }
        processed++;
      }
    } catch (e) { errors.push((e as Error).message); }
    return this.logLoop('eval_gate', processed, errors, started);
  }

  selectStrategy(): { strategy: string; exploration: boolean } {
    this.totalPulls++;
    this.epsilon = Math.max(0.01, this.epsilon * this.config.epsilon_decay);
    if (Math.random() < this.epsilon) {
      return { strategy: this.banditArms[Math.floor(Math.random()*this.banditArms.length)].strategy, exploration: true };
    }
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < this.banditArms.length; i++) {
      const a = this.banditArms[i];
      const ucb = a.mean_reward + this.config.ucb_exploration_weight * Math.sqrt(Math.log(this.totalPulls) / (a.pulls || 1));
      if (ucb > bestScore) { bestScore = ucb; best = i; }
    }
    return { strategy: this.banditArms[best].strategy, exploration: false };
  }

  recordReward(strategy: string, reward: number): void {
    const arm = this.banditArms.find(a => a.strategy === strategy);
    if (arm) { arm.pulls++; arm.total_reward += reward; arm.mean_reward = arm.total_reward / arm.pulls; }
  }

  async runDriftCheck(): Promise<LoopResult> {
    const started = new Date().toISOString(); const errors: string[] = [];
    try {
      const currentModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
      const stored = (this.db.prepare("SELECT value FROM system_state WHERE key='embedding_model'").get() as any)?.value;
      if (stored && stored !== currentModel) {
        this.db.prepare("INSERT OR REPLACE INTO system_state (key,value,updated_at) VALUES (?,?,?)").run('embedding_drift_detected', JSON.stringify({from:stored,to:currentModel}), new Date().toISOString());
        this.db.prepare("INSERT OR REPLACE INTO system_state (key,value,updated_at) VALUES (?,?,?)").run('reembed_required', 'true', new Date().toISOString());
      }
      this.db.prepare("INSERT OR REPLACE INTO system_state (key,value,updated_at) VALUES (?,?,?)").run('embedding_model', currentModel, new Date().toISOString());
    } catch (e) { errors.push((e as Error).message); }
    return this.logLoop('drift_check', 0, errors, started);
  }

  async syncToRedis(agentId: string, event: Record<string, string>): Promise<void> {
    if (!this.config.sync_enabled) return;
    try {
      const { execSync } = await import('child_process');
      const pass = process.env.REDIS_PASSWORD;
      if (!pass) return;
      const payload = Object.entries(event).map(([k,v]) => k+' '+v).join(' ');
      execSync("docker exec redis sh -c 'redis-cli -a "+pass+" XADD memory_events * agent_id "+agentId+" "+payload+"'", { timeout: 5000 });
    } catch { /* best-effort */ }
  }

  encrypt(plaintext: string, agentId: string): string {
    if (!this.config.encryption_enabled) return plaintext;
    const key = this.getOrCreateKey(agentId);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return iv.toString('hex')+':'+cipher.getAuthTag().toString('hex')+':'+enc.toString('hex');
  }

  decrypt(ciphertext: string, agentId: string): string {
    if (!this.config.encryption_enabled) return ciphertext;
    const key = this.getOrCreateKey(agentId);
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  }

  private getOrCreateKey(agentId: string): Buffer {
    const row = this.db.prepare('SELECT key_hash FROM memory_encryption_keys WHERE agent_id=?').get(agentId) as any;
    if (row) return Buffer.from(row.key_hash, 'hex');
    const password = process.env['ENCRYPTION_KEY_'+agentId.toUpperCase()] || process.env.ENCRYPTION_KEY || 'dev-key';
    const key = scryptSync(password, randomBytes(16), 32);
    this.db.prepare('INSERT OR REPLACE INTO memory_encryption_keys (agent_id,key_hash,created_at) VALUES (?,?,?)').run(agentId, key.toString('hex'), new Date().toISOString());
    return key;
  }

  private logLoop(type: string, processed: number, errors: string[], started: string): LoopResult {
    const completed = new Date().toISOString();
    this.db.prepare('INSERT INTO memory_evolution_log (id,loop_type,items_processed,errors_json,started_at,completed_at) VALUES (?,?,?,?,?,?)').run(
      'log-'+Date.now()+'-'+Math.random().toString(36).slice(2,8), type, processed, JSON.stringify(errors), started, completed);
    return { loop: type, started_at: started, completed_at: completed, items_processed: processed, errors };
  }

  getLoopStats(): Record<string, unknown> {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM memory_evolution_log').get() as any;
    const byType = this.db.prepare('SELECT loop_type, COUNT(*) as c, SUM(items_processed) as total FROM memory_evolution_log GROUP BY loop_type').all();
    const archived = this.db.prepare('SELECT COUNT(*) as c FROM memory_decay_state WHERE archived=1').get() as any;
    return { total_runs: total?.c || 0, by_type: byType, archived_count: archived?.c || 0, bandit_arms: this.banditArms, epsilon: this.epsilon };
  }
}
