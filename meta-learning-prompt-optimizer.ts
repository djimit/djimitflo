import type { Database } from "better-sqlite3";
import { randomUUID } from "crypto";

export interface MetaLearnedPrompt {
  id: string; domain: string; template: string;
  initialization: Record<string, number>;
  adaptationSteps: number; loss: number; createdAt: string;
}

export class MetaLearningPromptOptimizer {
  private lr: number;
  private steps: number;

  constructor(private db: Database, options: { lr?: number; steps?: number } = {}) {
    this.lr = options.lr ?? 0.1;
    this.steps = options.steps ?? 3;
    db.exec("CREATE TABLE IF NOT EXISTS meta_learned_prompts (id TEXT PRIMARY KEY, domain TEXT NOT NULL, template TEXT NOT NULL, initialization_json TEXT NOT NULL, adaptation_steps INTEGER DEFAULT 0, loss REAL DEFAULT 1.0, created_at TEXT DEFAULT (datetime('now')))");
  }

  metaTrain(examples: Array<{ domain: string; template: string; success: boolean }>): MetaLearnedPrompt {
    const byDomain = new Map<string, Array<{ template: string; success: boolean }>>();
    for (const ex of examples) {
      if (!byDomain.has(ex.domain)) byDomain.set(ex.domain, []);
      byDomain.get(ex.domain)!.push({ template: ex.template, success: ex.success });
    }
    let best: MetaLearnedPrompt | null = null;
    let bestLoss = Infinity;
    for (const [domain, exs] of byDomain) {
      const template = exs[0].template;
      const params = this.initParams(template);
      let totalLoss = 0;
      for (const ex of exs) {
        const target = ex.success ? 1.0 : 0.0;
        for (let s = 0; s < this.steps; s++) {
          const pred = this.forward(params, template);
          totalLoss += (pred - target) ** 2;
          this.step(params, template, pred, target);
        }
      }
      const avgLoss = totalLoss / exs.length;
      if (avgLoss < bestLoss) {
        bestLoss = avgLoss;
        best = { id: randomUUID(), domain, template, initialization: params, adaptationSteps: this.steps, loss: avgLoss, createdAt: new Date().toISOString() };
      }
    }
    const result = best ?? { id: randomUUID(), domain: "", template: "", initialization: {}, adaptationSteps: 0, loss: 1, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT OR REPLACE INTO meta_learned_prompts (id, domain, template, initialization_json, adaptation_steps, loss) VALUES (?, ?, ?, ?, ?, ?)").run(result.id, result.domain, result.template, JSON.stringify(result.initialization), result.adaptationSteps, result.loss);
    return result;
  }

  adapt(domain: string, examples: Array<{ template: string; success: boolean }>): { template: string; loss: number } {
    const meta = this.getMeta(domain);
    const params = meta ? { ...meta.initialization } : {};
    let totalLoss = 0;
    for (const ex of examples) {
      const target = ex.success ? 1.0 : 0.0;
      for (let s = 0; s < this.steps; s++) {
        const pred = this.forward(params, ex.template);
        totalLoss += (pred - target) ** 2;
        this.step(params, ex.template, pred, target);
      }
    }
    return { template: meta?.template ?? "", loss: examples.length > 0 ? totalLoss / examples.length : 1 };
  }

  getMeta(domain: string): MetaLearnedPrompt | null {
    const row = this.db.prepare("SELECT * FROM meta_learned_prompts WHERE domain = ? ORDER BY loss ASC LIMIT 1").get(domain) as any;
    if (!row) return null;
    return { id: row.id, domain: row.domain, template: row.template, initialization: JSON.parse(row.initialization_json), adaptationSteps: row.adaptation_steps, loss: row.loss, createdAt: row.created_at };
  }

  getAll(): MetaLearnedPrompt[] {
    const rows = this.db.prepare("SELECT * FROM meta_learned_prompts ORDER BY loss ASC").all() as any[];
    return rows.map(r => ({ id: r.id, domain: r.domain, template: r.template, initialization: JSON.parse(r.initialization_json), adaptationSteps: r.adaptation_steps, loss: r.loss, createdAt: r.created_at }));
  }

  private initParams(template: string): Record<string, number> {
    const params: Record<string, number> = { bias: 0.5 };
    const words = template.split(/s+/);
    for (let i = 0; i < Math.min(words.length, 10); i++) params["w" + i] = 0.1 * (i + 1);
    return params;
  }

  private forward(params: Record<string, number>, template: string): number {
    let sum = params.bias ?? 0.5;
    const words = template.split(/s+/);
    for (let i = 0; i < Math.min(words.length, 10); i++) sum += (params["w" + i] ?? 0) * (1 / (i + 1));
    return 1 / (1 + Math.exp(-sum));
  }

  private step(params: Record<string, number>, template: string, pred: number, target: number): void {
    const grad = pred - target;
    const words = template.split(/s+/);
    for (let i = 0; i < Math.min(words.length, 10); i++) {
      const key = "w" + i;
      params[key] = (params[key] ?? 0) - this.lr * grad * (1 / (i + 1));
    }
    params.bias = (params.bias ?? 0.5) - this.lr * grad;
  }
}