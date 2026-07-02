import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';


export interface MetaLearnedPrompt {
  id: string;
  domain: string;
  template: string;
  initialization: Record<string, number>;
  adaptationSteps: number;
  innerLoopLoss: number;
  outerLoopLoss: number;
  createdAt: string;
}

export interface AdaptationResult {
  domain: string;
  adaptedTemplate: string;
  steps: number;
  finalLoss: number;
  converged: boolean;
}

export class MetaLearningPromptOptimizer {
  private learningRate: number;
  private innerSteps: number;
  private convergenceThreshold: number;

  constructor(
    private db: Database,
    options: { learningRate?: number; innerSteps?: number; convergenceThreshold?: number } = {},
  ) {
    this.learningRate = options.learningRate ?? 0.1;
    this.innerSteps = options.innerSteps ?? 3;
    this.convergenceThreshold = options.convergenceThreshold ?? 0.05;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_learned_prompts (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        template TEXT NOT NULL,
        initialization_json TEXT NOT NULL,
        adaptation_steps INTEGER NOT NULL DEFAULT 0,
        inner_loop_loss REAL NOT NULL DEFAULT 1.0,
        outer_loop_loss REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  metaTrain(domainExamples: Array<{ domain: string; template: string; success: boolean }>): MetaLearnedPrompt {
    const byDomain = new Map<string, Array<{ template: string; success: boolean }>>();
    for (const ex of domainExamples) {
      if (!byDomain.has(ex.domain)) byDomain.set(ex.domain, []);
      byDomain.get(ex.domain)!.push({ template: ex.template, success: ex.success });
    }

    let bestDomain = '';
    let bestTemplate = '';
    let bestInitialization: Record<string, number> = {};
    let bestOuterLoss = Infinity;

    for (const [domain, examples] of byDomain) {
      const template = examples[0].template;

      let params = this.initializeParams(template);
      let outerLoss = 0;

      for (const example of examples) {
        const target = example.success ? 1.0 : 0.0;
        for (let step = 0; step < this.innerSteps; step++) {
          const prediction = this.forward(params, template);
          const loss = (prediction - target) ** 2;
          params = this.gradientStep(params, template, prediction, target);
          outerLoss += loss;
        }
      }

      outerLoss /= examples.length;

      if (outerLoss < bestOuterLoss) {
        bestOuterLoss = outerLoss;
        bestDomain = domain;
        bestTemplate = template;
        bestInitialization = params;
      }
    }

    const result: MetaLearnedPrompt = {
      id: randomUUID(),
      domain: bestDomain,
      template: bestTemplate,
      initialization: bestInitialization,
      adaptationSteps: this.innerSteps,
      innerLoopLoss: bestOuterLoss,
      outerLoopLoss: bestOuterLoss,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO meta_learned_prompts (id, domain, template, initialization_json, adaptation_steps, inner_loop_loss, outer_loop_loss)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(result.id, result.domain, result.template, JSON.stringify(result.initialization), result.adaptationSteps, result.innerLoopLoss, result.outerLoopLoss);

    return result;
  }

  adaptToDomain(domain: string, examples: Array<{ template: string; success: boolean }>): AdaptationResult {
    const metaPrompt = this.getMetaPrompt(domain);
    const params = metaPrompt ? { ...metaPrompt.initialization } : this.initializeParams('');

    let finalLoss = 0;
    let converged = false;

    for (let step = 0; step < this.innerSteps; step++) {
      let stepLoss = 0;
      for (const example of examples) {
        const target = example.success ? 1.0 : 0.0;
        const prediction = this.forward(params, example.template);
        stepLoss += (prediction - target) ** 2;
        this.gradientStep(params, example.template, prediction, target);
      }
      stepLoss /= examples.length;
      finalLoss = stepLoss;

      if (stepLoss < this.convergenceThreshold) {
        converged = true;
        break;
      }
    }

    return {
      domain,
      adaptedTemplate: this.applyParams(params, metaPrompt?.template ?? ''),
      steps: this.innerSteps,
      finalLoss,
      converged,
    };
  }

  getMetaPrompt(domain: string): MetaLearnedPrompt | null {
    const row = this.db.prepare('SELECT * FROM meta_learned_prompts WHERE domain = ? ORDER BY outer_loop_loss ASC LIMIT 1').get(domain) as {
      id: string; domain: string; template: string; initialization_json: string;
      adaptation_steps: number; inner_loop_loss: number; outer_loop_loss: number; created_at: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id, domain: row.domain, template: row.template,
      initialization: JSON.parse(row.initialization_json) as Record<string, number>,
      adaptationSteps: row.adaptation_steps, innerLoopLoss: row.inner_loop_loss,
      outerLoopLoss: row.outer_loop_loss, createdAt: row.created_at,
    };
  }

  getAllMetaPrompts(): MetaLearnedPrompt[] {
    const rows = this.db.prepare('SELECT * FROM meta_learned_prompts ORDER BY outer_loop_loss ASC').all() as Array<{
      id: string; domain: string; template: string; initialization_json: string;
      adaptation_steps: number; inner_loop_loss: number; outer_loop_loss: number; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, domain: r.domain, template: r.template,
      initialization: JSON.parse(r.initialization_json) as Record<string, number>,
      adaptationSteps: r.adaptation_steps, innerLoopLoss: r.inner_loop_loss,
      outerLoopLoss: r.outer_loop_loss, createdAt: r.created_at,
    }));
  }

  private initializeParams(template: string): Record<string, number> {
    const params: Record<string, number> = {};
    const words = template.split(/\s+/);
    for (let i = 0; i < Math.min(words.length, 10); i++) {
      params[`w${i}`] = 0.1 * (i + 1);
    }
    params['bias'] = 0.5;
    return params;
  }

  private forward(params: Record<string, number>, template: string): number {
    let sum = params['bias'] ?? 0.5;
    const words = template.split(/\s+/);
    for (let i = 0; i < Math.min(words.length, 10); i++) {
      sum += (params[`w${i}`] ?? 0) * (1 / (i + 1));
    }
    return 1 / (1 + Math.exp(-sum));
  }

  private gradientStep(params: Record<string, number>, template: string, prediction: number, target: number): Record<string, number> {
    const grad = prediction - target;
    const newParams = { ...params };
    const words = template.split(/\s+/);

    for (let i = 0; i < Math.min(words.length, 10); i++) {
      const key = `w${i}`;
      newParams[key] = (newParams[key] ?? 0) - this.learningRate * grad * (1 / (i + 1));
    }
    newParams['bias'] = (newParams['bias'] ?? 0.5) - this.learningRate * grad;

    return newParams;
  }

  private applyParams(params: Record<string, number>, template: string): string {
    return template.replace(/\{(\w+)\}/g, (_match, key) => {
      const val = params[key];
      return val !== undefined ? val.toFixed(2) : `{${key}}`;
    });
  }
}
