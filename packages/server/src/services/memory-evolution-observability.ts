import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface GenealogyNode {
  id: string; title: string; status: string; created_at: string;
  parent_id: string | null; children: string[]; evidence_refs: string[];
}

export interface QualityTimeSeries {
  timestamp: string; composite_avg: number; promotion_rate: number;
  decay_rate: number; total_candidates: number; total_promoted: number;
}

export interface ContradictionAlert {
  id: string; candidate_a: string; candidate_b: string;
  contradiction_type: string; severity: 'low' | 'medium' | 'high'; detected_at: string;
}

export interface PerformanceBenchmark {
  search_latency_p95_ms: number; ingestion_throughput_per_min: number;
  total_entries: number; concurrent_writers: number; timestamp: string;
}

export class MemoryEvolutionObservability {
  constructor(private db: Database) {}

  getGenealogy(candidateId: string): GenealogyNode {
    const c = this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(candidateId) as any;
    if (!c) throw new Error('CANDIDATE_NOT_FOUND');
    const meta = JSON.parse(c.metadata || '{}');
    const children = this.db.prepare("SELECT id FROM memory_candidates WHERE json_extract(metadata,'$.consolidated_into')=?").all(candidateId) as any[];
    const parentRow = meta.consolidated_into ? this.db.prepare('SELECT id FROM memory_candidates WHERE id=?').get(meta.consolidated_into) as any : null;
    return { id: c.id, title: c.title, status: c.status, created_at: c.created_at, parent_id: parentRow?.id || null, children: children.map((r: any) => r.id), evidence_refs: meta.evidence_refs || [] };
  }

  getProvenanceChain(candidateId: string, maxDepth = 10): GenealogyNode[] {
    const chain: GenealogyNode[] = []; let currentId: string | null = candidateId; let depth = 0;
    while (currentId && depth < maxDepth) { try { const n = this.getGenealogy(currentId); chain.push(n); currentId = n.parent_id; depth++; } catch { break; } }
    return chain;
  }

  getQualityTimeSeries(days = 30): QualityTimeSeries[] {
    const results: QualityTimeSeries[] = []; const now = Date.now();
    for (let d = days; d >= 0; d--) {
      const dayStart = new Date(now - d * 86400000).toISOString().slice(0, 10);
      const dayEnd = new Date(now - (d - 1) * 86400000).toISOString().slice(0, 10);
      const candidates = this.db.prepare("SELECT * FROM memory_candidates WHERE created_at >= ? AND created_at < ?").all(dayStart, dayEnd) as any[];
      const promoted = candidates.filter((c: any) => c.status === 'promoted').length;
      const archived = (this.db.prepare("SELECT COUNT(*) as c FROM memory_decay_state WHERE archived=1 AND last_accessed >= ? AND last_accessed < ?").get(dayStart, dayEnd) as any)?.c || 0;
      let compositeSum = 0;
      for (const c of candidates) { const m = JSON.parse(c.metadata||'{}'); compositeSum += 0.25*(c.status==='promoted'?0.9:0.5) + 0.20*(m.promoted_at?0.8:0.4) + 0.15*0.5 + 0.15*0.5 + 0.15*0.6 + 0.10*0.5; }
      results.push({ timestamp: dayStart, composite_avg: candidates.length>0?compositeSum/candidates.length:0, promotion_rate: candidates.length>0?promoted/candidates.length:0, decay_rate: archived, total_candidates: candidates.length, total_promoted: promoted });
    }
    return results;
  }

  detectContradictions(): ContradictionAlert[] {
    const alerts: ContradictionAlert[] = [];
    const candidates = this.db.prepare("SELECT * FROM memory_candidates WHERE status IN ('candidate','promoted')").all() as any[];
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.memory_type !== b.memory_type) continue;
      const aW = new Set((a.content||'').toLowerCase().split(/\W+/).filter(Boolean));
      const bW = new Set((b.content||'').toLowerCase().split(/\W+/).filter(Boolean));
      const overlap = new Set([...aW].filter(x => bW.has(x))).size, union = new Set([...aW,...bW]).size;
      if (union > 0 && overlap/union > 0.5 && /always|must|never|prohibited/.test(a.content||'') && /always|must|never|prohibited/.test(b.content||'')) {
        alerts.push({ id: randomUUID(), candidate_a: a.id, candidate_b: b.id, contradiction_type: 'semantic_overlap_rules', severity: overlap/union > 0.8 ? 'high' : 'medium', detected_at: new Date().toISOString() });
      }
    }
    return alerts;
  }

  runBenchmarks(): PerformanceBenchmark {
    const start = Date.now();
    this.db.prepare("SELECT id FROM memory_candidates WHERE content LIKE ?").all('%test%');
    return { search_latency_p95_ms: Date.now()-start, ingestion_throughput_per_min: (this.db.prepare("SELECT COUNT(*) as c FROM memory_candidates WHERE created_at > datetime('now','-1 hour')").get() as any)?.c || 0, total_entries: (this.db.prepare('SELECT COUNT(*) as c FROM memory_candidates').get() as any)?.c || 0, concurrent_writers: 1, timestamp: new Date().toISOString() };
  }

  exportBackup(): { candidates: unknown[]; decay_state: unknown[]; evolution_log: unknown[]; timestamp: string } {
    return { candidates: this.db.prepare('SELECT * FROM memory_candidates').all(), decay_state: this.db.prepare('SELECT * FROM memory_decay_state').all(), evolution_log: this.db.prepare('SELECT * FROM memory_evolution_log').all(), timestamp: new Date().toISOString() };
  }

  importBackup(backup: { candidates: any[]; decay_state: any[]; evolution_log: any[] }): { restored: number } {
    let restored = 0;
    for (const c of backup.candidates) { this.db.prepare("INSERT OR REPLACE INTO memory_candidates (id,title,content,memory_type,store,source_ref,status,promotion_status,human_required,sensitivity,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(c.id,c.title,c.content,c.memory_type,c.store,c.source_ref,c.status,c.promotion_status,c.human_required,c.sensitivity,c.metadata,c.created_at,c.updated_at); restored++; }
    for (const d of backup.decay_state) this.db.prepare("INSERT OR REPLACE INTO memory_decay_state (candidate_id,decay_factor,last_accessed,archived) VALUES (?,?,?,?)").run(d.candidate_id,d.decay_factor,d.last_accessed,d.archived);
    for (const l of backup.evolution_log) this.db.prepare("INSERT OR REPLACE INTO memory_evolution_log (id,loop_type,items_processed,errors_json,started_at,completed_at) VALUES (?,?,?,?,?,?)").run(l.id,l.loop_type,l.items_processed,l.errors_json,l.started_at,l.completed_at);
    return { restored };
  }
}
