import type { Database } from 'better-sqlite3';

export interface ExperienceResult {
  runId: string;
  objective: string;
  outcome: 'success' | 'failure';
  retries: number;
  runtime: string;
  capabilityId: string;
  lessons: string[];
  similarity: number;
  totalTokens: number;
  createdAt: string;
}

interface LoopRunRow {
  id: string;
  goal_id: string | null;
  status: string;
  created_at: string;
}

interface GoalRow {
  id: string;
  objective: string;
}

interface LeaseRow {
  loop_run_id: string;
  runtime: string;
  capability_id: string | null;
  status: string;
  metadata: string;
}

interface ExperienceRow {
  run_id: string;
  objective: string;
  outcome: string;
  retries: number;
  runtime: string;
  capability_id: string;
  lessons: string;
  total_tokens: number;
  created_at: string;
}

export class ExperienceRetrievalService {
  private qdrantUrl: string;
  private collectionName = 'djimitflo_experience';

  constructor(
    private db: Database,
    qdrantUrl: string = process.env.QDRANT_URL || 'http://192.168.1.28:6333',
  ) {
    this.qdrantUrl = qdrantUrl.replace(/\/$/, '');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experience_embeddings (
        run_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
        retries INTEGER NOT NULL DEFAULT 0,
        runtime TEXT NOT NULL,
        capability_id TEXT,
        lessons TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exp_outcome ON experience_embeddings(outcome)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exp_runtime ON experience_embeddings(runtime)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exp_capability ON experience_embeddings(capability_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exp_created ON experience_embeddings(created_at)');
  }

  async indexRun(loopRunId: string): Promise<void> {
    const run = this.db.prepare('SELECT id, goal_id, status, created_at FROM loop_runs WHERE id = ?').get(loopRunId) as LoopRunRow | undefined;
    if (!run) return;

    let objective = run.id;
    if (run.goal_id) {
      const goal = this.db.prepare('SELECT id, objective FROM goals WHERE id = ?').get(run.goal_id) as GoalRow | undefined;
      if (goal) objective = goal.objective;
    }

    const leases = this.db.prepare('SELECT loop_run_id, runtime, capability_id, status, metadata FROM worker_leases WHERE loop_run_id = ?').all(loopRunId) as LeaseRow[];
    const makers = leases.filter(l => l.status === 'completed' || l.status === 'failed');
    const primaryMaker = makers.find(l => l.status === 'completed') || makers[0];
    const runtime = primaryMaker?.runtime || 'unknown';
    const capabilityId = primaryMaker?.capability_id || '';
    const retries = Math.max(0, makers.length - 1);
    const outcome: 'success' | 'failure' = (run.status === 'completed' || run.status === 'certified') ? 'success' : 'failure';

    let totalTokens = 0;
    for (const lease of leases) {
      try {
        const meta = JSON.parse(lease.metadata || '{}');
        const usage = meta.runtime_usage as { total_tokens?: number } | undefined;
        if (usage?.total_tokens) totalTokens += usage.total_tokens;
      } catch { /* skip */ }
    }

    this.db.prepare(
      'INSERT OR REPLACE INTO experience_embeddings (run_id, objective, outcome, retries, runtime, capability_id, lessons, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(loopRunId, objective, outcome, retries, runtime, capabilityId, '[]', totalTokens, run.created_at);

    try {
      await this.upsertToQdrant(loopRunId, objective, outcome);
    } catch { /* best-effort */ }
  }

  async retrieveRelevantRuns(objective: string, limit: number = 5): Promise<ExperienceResult[]> {
    try {
      const qdrantResults = await this.queryQdrant(objective, limit);
      if (qdrantResults.length > 0) return qdrantResults;
    } catch { /* fallback */ }
    return this.retrieveFromDb(objective, limit);
  }

  formatExperienceContext(results: ExperienceResult[]): string {
    if (results.length === 0) return '';
    const lines: string[] = ['## Past Experience', ''];
    for (const r of results) {
      lines.push('### ' + (r.outcome === 'success' ? 'Success' : 'Failure') + ': ' + r.objective);
      lines.push('- Runtime: ' + r.runtime + ', Retries: ' + r.retries + ', Tokens: ' + r.totalTokens);
      if (r.lessons.length > 0) lines.push('- Lessons: ' + r.lessons.join('; '));
      lines.push('');
    }
    return lines.join('\n');
  }

  async purgeOld(maxDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - maxDays * 86400000).toISOString();
    const result = this.db.prepare('DELETE FROM experience_embeddings WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  private async upsertToQdrant(runId: string, objective: string, outcome: string): Promise<void> {
    try {
      const embedding = await this.embedText(objective);
      if (!embedding) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      await fetch(this.qdrantUrl + '/collections/' + this.collectionName + '/points', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: [{ id: runId, vector: embedding, payload: { objective, outcome } }] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch { /* best-effort */ }
  }

  private async queryQdrant(objective: string, limit: number): Promise<ExperienceResult[]> {
    const embedding = await this.embedText(objective);
    if (!embedding) return [];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(this.qdrantUrl + '/collections/' + this.collectionName + '/points/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: embedding, limit, with_payload: true }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return [];
      const data = await response.json() as { result?: Array<{ id: string; score: number }> };
      if (!data.result) return [];
      const results: ExperienceResult[] = [];
      for (const point of data.result) {
        const dbRow = this.db.prepare('SELECT * FROM experience_embeddings WHERE run_id = ?').get(point.id) as ExperienceRow | undefined;
        if (!dbRow) continue;
        results.push({
          runId: dbRow.run_id, objective: dbRow.objective, outcome: dbRow.outcome as 'success' | 'failure',
          retries: dbRow.retries, runtime: dbRow.runtime, capabilityId: dbRow.capability_id,
          lessons: JSON.parse(dbRow.lessons || '[]'), similarity: point.score,
          totalTokens: dbRow.total_tokens, createdAt: dbRow.created_at,
        });
      }
      return results;
    } catch { return []; }
  }

  private async embedText(text: string): Promise<number[] | null> {
    try {
      const ollamaUrl = process.env.OLLAMA_URL || 'http://192.168.1.28:11434';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(ollamaUrl + '/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return null;
      const data = await response.json() as { embedding?: number[] };
      return data.embedding || null;
    } catch { return null; }
  }

  private retrieveFromDb(objective: string, limit: number): ExperienceResult[] {
    const words = objective.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length === 0) return [];
    const conditions = words.map(() => 'objective LIKE ?').join(' OR ');
    const params = words.map(w => '%' + w + '%');
    const rows = this.db.prepare(
      'SELECT * FROM experience_embeddings WHERE ' + conditions + ' ORDER BY created_at DESC LIMIT ?'
    ).all(...params, limit) as ExperienceRow[];
    return rows.map(r => ({
      runId: r.run_id,
      objective: r.objective,
      outcome: r.outcome as 'success' | 'failure',
      retries: r.retries,
      runtime: r.runtime,
      capabilityId: r.capability_id,
      lessons: JSON.parse(r.lessons || '[]'),
      similarity: 0.5,
      totalTokens: r.total_tokens,
      createdAt: r.created_at,
    }));
  }
}
