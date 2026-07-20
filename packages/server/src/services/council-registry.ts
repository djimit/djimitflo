import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';

type PrivacyClass = 'local' | 'private_cloud' | 'public_api';
type ModelStatus = 'active' | 'inactive' | 'deprecated';

export interface CouncilModelRecord {
  id: string;
  provider: string;
  model_name: string;
  capabilities: string[];
  reasoning_depth: number;
  cost_per_1m_tokens: number;
  privacy_class: PrivacyClass;
  independence_score: number;
  avg_governance_score: number;
  total_sessions: number;
  total_tokens: number;
  avg_latency_ms: number;
  status: ModelStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CouncilModelInput {
  provider: string;
  model_name: string;
  capabilities?: string[];
  reasoning_depth?: number;
  cost_per_1m_tokens?: number;
  privacy_class?: PrivacyClass;
  independence_score?: number;
  avg_governance_score?: number;
  metadata?: Record<string, unknown>;
}

export interface CouncilSelection {
  models: CouncilModelRecord[];
  diversity_score: number;
  estimated_cost: number;
  estimated_latency_ms: number;
}

export class CouncilRegistry {
  constructor(private db: Database) {}

  registerModel(input: CouncilModelInput): CouncilModelRecord {
    if (!input.provider?.trim()) throw new Error('COUNCIL_MODEL_PROVIDER_REQUIRED');
    if (!input.model_name?.trim()) throw new Error('COUNCIL_MODEL_NAME_REQUIRED');

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO council_models (
        id, provider, model_name, capabilities, reasoning_depth,
        cost_per_1m_tokens, privacy_class, independence_score,
        avg_governance_score, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.provider.trim(),
      input.model_name.trim(),
      JSON.stringify(input.capabilities ?? []),
      input.reasoning_depth ?? 1,
      input.cost_per_1m_tokens ?? 0,
      input.privacy_class ?? 'public_api',
      input.independence_score ?? 0.5,
      input.avg_governance_score ?? 0,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    );

    swarmEventBus.emit('council:model:registered', {
      model_id: id,
      provider: input.provider,
      model_name: input.model_name,
    });

    return this.getModel(id);
  }

  getModel(id: string): CouncilModelRecord {
    const row = this.db.prepare('SELECT * FROM council_models WHERE id = ?').get(id) as any;
    if (!row) throw new Error('COUNCIL_MODEL_NOT_FOUND');
    return this.parseModel(row);
  }

  listModels(status?: ModelStatus): CouncilModelRecord[] {
    const query = status
      ? 'SELECT * FROM council_models WHERE status = ? ORDER BY avg_governance_score DESC'
      : 'SELECT * FROM council_models ORDER BY avg_governance_score DESC';
    const rows = status
      ? this.db.prepare(query).all(status)
      : this.db.prepare(query).all();
    return (rows as any[]).map(r => this.parseModel(r));
  }

  updateModelStats(id: string, tokens: number, latencyMs: number): void {
    const model = this.getModel(id);
    const newTotal = model.total_sessions + 1;
    const newTokens = model.total_tokens + tokens;
    const newAvgLatency = Math.round(
      (model.avg_latency_ms * model.total_sessions + latencyMs) / newTotal,
    );

    this.db.prepare(`
      UPDATE council_models
      SET total_sessions = ?, total_tokens = ?, avg_latency_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(newTotal, newTokens, newAvgLatency, new Date().toISOString(), id);
  }

  deprecateModel(id: string): void {
    this.db.prepare(`
      UPDATE council_models SET status = 'deprecated', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);

    swarmEventBus.emit('council:model:deprecated', { model_id: id });
  }

  selectModelsForCouncil(config: {
    mode: 'fast' | 'review' | 'council';
    risk_class: 'low' | 'medium' | 'high' | 'critical';
    privacy_required?: PrivacyClass;
    min_independence?: number;
    max_cost?: number;
  }): CouncilSelection {
    const activeModels = this.listModels('active');

    if (activeModels.length === 0) {
      throw new Error('COUNCIL_NO_ACTIVE_MODELS');
    }

    let selected: CouncilModelRecord[] = [];

    if (config.mode === 'fast') {
      selected = this.selectSingle(activeModels, config);
    } else if (config.mode === 'review') {
      selected = this.selectPair(activeModels, config);
    } else {
      selected = this.selectDiverse(activeModels, config);
    }

    const diversity_score = this.calculateDiversityScore(selected);
    const estimated_cost = selected.reduce((sum, m) => sum + m.cost_per_1m_tokens * 0.01, 0);
    const estimated_latency_ms = Math.max(...selected.map(m => m.avg_latency_ms || 5000));

    return { models: selected, diversity_score, estimated_cost, estimated_latency_ms };
  }

  private selectSingle(models: CouncilModelRecord[], config: { privacy_required?: PrivacyClass }): CouncilModelRecord[] {
    let candidates = models;
    if (config.privacy_required === 'local') {
      candidates = candidates.filter(m => m.privacy_class === 'local');
    }
    if (candidates.length === 0) candidates = models;
    return [candidates.sort((a, b) => b.avg_governance_score - a.avg_governance_score)[0]];
  }

  private selectPair(models: CouncilModelRecord[], config: { privacy_required?: PrivacyClass }): CouncilModelRecord[] {
    let candidates = models;
    if (config.privacy_required === 'local') {
      candidates = candidates.filter(m => m.privacy_class === 'local');
    }
    if (candidates.length < 2) candidates = models;

    const sorted = candidates.sort((a, b) => b.avg_governance_score - a.avg_governance_score);
    const generator = sorted[0];
    const critic = sorted.find(m => m.provider !== generator.provider) ?? sorted[1];
    return critic ? [generator, critic] : [generator];
  }

  private selectDiverse(models: CouncilModelRecord[], config: {
    risk_class: string;
    privacy_required?: PrivacyClass;
    min_independence?: number;
    max_cost?: number;
  }): CouncilModelRecord[] {
    let candidates = models.slice();

    if (config.privacy_required) {
      const privacyFiltered = candidates.filter(m => m.privacy_class === config.privacy_required);
      if (privacyFiltered.length >= 3) candidates = privacyFiltered;
    }

    if (config.min_independence) {
      candidates = candidates.filter(m => m.independence_score >= config.min_independence!);
    }

    if (config.max_cost) {
      candidates = candidates.filter(m => m.cost_per_1m_tokens <= config.max_cost!);
    }

    if (candidates.length < 3) candidates = models.slice();

    const selected: CouncilModelRecord[] = [];
    const usedProviders = new Set<string>();

    const sorted = candidates.sort((a, b) => b.avg_governance_score - a.avg_governance_score);

    for (const model of sorted) {
      if (selected.length >= 5) break;
      if (usedProviders.has(model.provider) && selected.length < 3) continue;
      selected.push(model);
      usedProviders.add(model.provider);
    }

    if (selected.length < 3) {
      for (const model of sorted) {
        if (selected.length >= 3) break;
        if (!selected.includes(model)) selected.push(model);
      }
    }

    return selected;
  }

  private calculateDiversityScore(models: CouncilModelRecord[]): number {
    if (models.length <= 1) return 0;
    const providers = new Set(models.map(m => m.provider));
    const privacyClasses = new Set(models.map(m => m.privacy_class));
    const providerDiversity = providers.size / models.length;
    const privacyDiversity = privacyClasses.size / 3;
    return Math.round((providerDiversity * 0.6 + privacyDiversity * 0.4) * 100) / 100;
  }

  private parseModel(row: any): CouncilModelRecord {
    return {
      id: row.id,
      provider: row.provider,
      model_name: row.model_name,
      capabilities: JSON.parse(row.capabilities || '[]'),
      reasoning_depth: row.reasoning_depth,
      cost_per_1m_tokens: row.cost_per_1m_tokens,
      privacy_class: row.privacy_class,
      independence_score: row.independence_score,
      avg_governance_score: row.avg_governance_score,
      total_sessions: row.total_sessions,
      total_tokens: row.total_tokens,
      avg_latency_ms: row.avg_latency_ms,
      status: row.status,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
