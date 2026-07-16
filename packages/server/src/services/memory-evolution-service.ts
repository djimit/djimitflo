import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export type EvolutionLeaseRole = 'memory_evaluator' | 'memory_consolidator' | 'memory_pruner';
export type EvolutionLeaseStatus = 'prepared' | 'running' | 'completed' | 'failed';

export interface MemoryEvolutionLease {
  id: string; loop_run_id: string; role: EvolutionLeaseRole; runtime: string;
  status: EvolutionLeaseStatus; memory_candidate_id: string | null;
  metadata: Record<string, unknown>; created_at: string; updated_at: string;
}

export interface EvaluatorResult {
  candidateId: string; outcomeDelta: number; verdict: 'promote' | 'reject' | 'undetermined';
  confidence: number; evidence: string;
}

export interface ConsolidationResult {
  mergedIds: string[]; survivingId: string; cosineScore: number; reEmbedded: boolean;
}

export interface PruningResult {
  candidateId: string; compositeScore: number; action: 'keep' | 'archive' | 'delete';
  weights: { w1: number; w2: number; w3: number; w4: number; w5: number; w6: number };
}


export interface QualityScore {
  candidateId: string;
  discrimination: number; stability: number; novelty: number;
  consolidation: number; decayResistance: number; crossAgentUsage: number;
  composite: number; promotionEligible: boolean;
}

export interface GoalTemplate {
  id: string; objective: string; goalType: 'consolidation' | 'pruning' | 'evaluation';
  status: string; metadata: Record<string, unknown>; created_at: string;
}

export class MemoryEvolutionService {
  private readonly WEIGHTS = { w1: 0.25, w2: 0.20, w3: 0.15, w4: 0.15, w5: 0.15, w6: 0.10 };
  constructor(private db: Database) { this.ensureTables(); }

  private ensureTables(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS memory_evolution_leases (id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('memory_evaluator','memory_consolidator','memory_pruner')), runtime TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','running','completed','failed')), memory_candidate_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS idx_mel_loop_run ON memory_evolution_leases(loop_run_id);CREATE INDEX IF NOT EXISTS idx_mel_role ON memory_evolution_leases(role);CREATE INDEX IF NOT EXISTS idx_mel_candidate ON memory_evolution_leases(memory_candidate_id);");
  }

  createLease(i: { loopRunId: string; role: EvolutionLeaseRole; memory_candidate_id?: string | null; metadata?: Record<string, unknown> }): MemoryEvolutionLease {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO memory_evolution_leases (id,loop_run_id,role,runtime,status,memory_candidate_id,metadata,created_at,updated_at) VALUES (?,?,?,'local','prepared',?,?,?,?)").run(id, i.loopRunId, i.role, i.memory_candidate_id||null, JSON.stringify(i.metadata||{}), now, now);
    return this.getLease(id);
  }

  getLease(id: string): MemoryEvolutionLease {
    const row = this.db.prepare('SELECT * FROM memory_evolution_leases WHERE id = ?').get(id) as any;
    if (!row) throw new Error('MEMORY_EVOLUTION_LEASE_NOT_FOUND');
    return this.parse(row);
  }

  listLeases(f?: { loopRunId?: string; role?: EvolutionLeaseRole; status?: EvolutionLeaseStatus }): MemoryEvolutionLease[] {
    let sql = 'SELECT * FROM memory_evolution_leases WHERE 1=1'; const p: unknown[] = [];
    if (f?.loopRunId) { sql += ' AND loop_run_id = ?'; p.push(f.loopRunId); }
    if (f?.role) { sql += ' AND role = ?'; p.push(f.role); }
    if (f?.status) { sql += ' AND status = ?'; p.push(f.status); }
    return (this.db.prepare(sql + ' ORDER BY created_at DESC').all(...p) as any[]).map(r => this.parse(r));
  }

  updateLeaseStatus(id: string, s: EvolutionLeaseStatus, m?: Record<string, unknown>): MemoryEvolutionLease {
    const ex = this.getLease(id); this.db.prepare('UPDATE memory_evolution_leases SET status=?,metadata=?,updated_at=? WHERE id=?').run(s, JSON.stringify({...ex.metadata, ...(m||{})}), new Date().toISOString(), id);
    return this.getLease(id);
  }

  verifyMakerChecker(lrid: string): { maker: boolean; checker: boolean } {
    return { maker: !!this.db.prepare("SELECT 1 FROM worker_leases WHERE loop_run_id=? AND role='maker' AND status='completed'").get(lrid), checker: !!this.db.prepare("SELECT 1 FROM worker_leases WHERE loop_run_id=? AND role='checker' AND status='completed'").get(lrid) };
  }

  evaluateCandidate(lid: string): EvaluatorResult {
    const lease = this.getLease(lid);
    if (lease.role !== 'memory_evaluator') throw new Error('LEASE_ROLE_MISMATCH');
    this.updateLeaseStatus(lid, 'running');
    try {
      const c = lease.memory_candidate_id ? this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(lease.memory_candidate_id) as any : null;
      if (!c) { this.updateLeaseStatus(lid,'failed',{error:'not_found'}); return {candidateId:'',outcomeDelta:0,verdict:'reject',confidence:1,evidence:'Not found'}; }
      const len=c.content?.length||0; const struct=/\{.*\}|```|> |- /.test(c.content||''); const spec=/\d+|example|because|when|if/.test(c.content||'');
      const score=Math.min(1,(len>100?0.3:0)+(struct?0.3:0)+(spec?0.4:0));
      const v: EvaluatorResult['verdict'] = score>=0.6?'promote':score>=0.3?'undetermined':'reject';
      this.updateLeaseStatus(lid,'completed',{score,verdict:v});
      return {candidateId:c.id,outcomeDelta:score,verdict:v,confidence:0.7,evidence:'len='+len+',struct='+struct+',spec='+spec};
    } catch(e) { this.updateLeaseStatus(lid,'failed',{error:(e as Error).message}); throw e; }
  }

  consolidate(lid: string, cids: string[]): ConsolidationResult {
    const lease = this.getLease(lid);
    if (lease.role !== 'memory_consolidator') throw new Error('LEASE_ROLE_MISMATCH');
    this.updateLeaseStatus(lid, 'running');
    try {
      const cs = cids.map(id=>this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(id) as any).filter(Boolean);
      if (cs.length < 2) { this.updateLeaseStatus(lid,'completed',{merged:0}); return {mergedIds:[],survivingId:cids[0]||'',cosineScore:1,reEmbedded:false}; }
      const tok=(s:string)=>new Set((s||'').toLowerCase().split(/\W+/).filter(Boolean));
      let bp:[number,number,number]=[0,0,0];
      for(let i=0;i<cs.length;i++) for(let j=i+1;j<cs.length;j++) {
        const a=tok(cs[i].title+' '+cs[i].content), b=tok(cs[j].title+' '+cs[j].content);
        const inter=new Set([...a].filter(x=>b.has(x))).size, union=new Set([...a,...b]).size;
        const jacc=union>0?inter/union:0; if(jacc>bp[2])bp=[i,j,jacc];
      }
      const merged:string[]=[]; let surv=cs[0].id;
      if(bp[2]>0.85){
        const[i,j]=bp; const keeper=cs[i].content.length>=cs[j].content.length?cs[i]:cs[j];
        const victim=keeper.id===cs[i].id?cs[j]:cs[i]; surv=keeper.id; merged.push(victim.id);
        this.db.prepare("UPDATE memory_candidates SET metadata=json_set(COALESCE(metadata,'{}'),'$.consolidated_into',?,'$.consolidated_at',?,'$.consolidation_score',?),status='rejected',promotion_status='rejected',updated_at=? WHERE id=?").run(keeper.id,new Date().toISOString(),bp[2],new Date().toISOString(),victim.id);
      }
      this.updateLeaseStatus(lid,'completed',{mergedIds:merged,survivingId:surv});
      return {mergedIds:merged,survivingId:surv,cosineScore:bp[2],reEmbedded:false};
    } catch(e) { this.updateLeaseStatus(lid,'failed',{error:(e as Error).message}); throw e; }
  }

  pruneCandidate(lid: string): PruningResult {
    const lease = this.getLease(lid);
    if (lease.role !== 'memory_pruner') throw new Error('LEASE_ROLE_MISMATCH');
    this.updateLeaseStatus(lid, 'running');
    try {
      const c = lease.memory_candidate_id ? this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(lease.memory_candidate_id) as any : null;
      if (!c) { this.updateLeaseStatus(lid,'failed',{error:'not_found'}); return {candidateId:'',compositeScore:0,action:'delete',weights:this.WEIGHTS}; }
      const meta=JSON.parse(c.metadata||'{}'); const daysOld=(Date.now()-new Date(c.created_at).getTime())/86400000;
      const disc=c.status==='promoted'?0.9:c.status==='candidate'?0.5:0.2;
      const stab=meta.promoted_at?0.8:0.4; const nov=Math.max(0,1-daysOld/30);
      const cons=meta.consolidated_into?0.1:meta.distilled?0.7:0.5;
      const decay=c.memory_type==='policy_rule'?0.9:c.memory_type==='engineering_rule'?0.7:0.5;
      const cross=0.5; const{w1,w2,w3,w4,w5,w6}=this.WEIGHTS;
      const comp=w1*disc+w2*stab+w3*nov+w4*cons+w5*decay+w6*cross;
      const action: PruningResult['action'] = comp>=0.7?'keep':comp>=0.3?'archive':'delete';
      this.updateLeaseStatus(lid,'completed',{compositeScore:comp,action});
      return {candidateId:c.id,compositeScore:comp,action,weights:this.WEIGHTS};
    } catch(e) { this.updateLeaseStatus(lid,'failed',{error:(e as Error).message}); throw e; }
  }

  private parse(row: any): MemoryEvolutionLease {
    return {id:row.id,loop_run_id:row.loop_run_id,role:row.role,runtime:row.runtime,status:row.status,memory_candidate_id:row.memory_candidate_id,metadata:JSON.parse(row.metadata||'{}'),created_at:row.created_at,updated_at:row.updated_at};
  }

  computeQualityScore(candidateId: string): QualityScore {
    const c = this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(candidateId) as any;
    if (!c) throw new Error('CANDIDATE_NOT_FOUND');
    const meta = JSON.parse(c.metadata||'{}');
    const daysOld = (Date.now()-new Date(c.created_at).getTime())/86400000;
    const discrimination = c.status==='promoted'?0.9:c.status==='candidate'?0.5:c.status==='review_required'?0.3:0.1;
    const stability = meta.promoted_at?0.8:meta.distilled?0.6:0.4;
    const novelty = Math.max(0,1-daysOld/30);
    const consolidation = meta.consolidated_into?0.1:meta.distilled?0.7:0.5;
    const decayResistance = c.memory_type==='policy_rule'?0.9:c.memory_type==='engineering_rule'?0.7:0.5;
    const crossAgentUsage = 0.5;
    const {w1,w2,w3,w4,w5,w6} = this.WEIGHTS;
    const composite = w1*discrimination+w2*stability+w3*novelty+w4*consolidation+w5*decayResistance+w6*crossAgentUsage;
    return {candidateId:c.id,discrimination,stability,novelty,consolidation,decayResistance,crossAgentUsage,composite,promotionEligible:composite>=0.7&&discrimination>=0.6};
  }

  validateWithBenchmark(candidateId: string): {hierarchy:number;injection:number;contradiction:number;canary:number;pass:boolean} {
    const c = this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(candidateId) as any;
    if (!c) throw new Error('CANDIDATE_NOT_FOUND');
    const meta = JSON.parse(c.metadata||'{}');
    const hasHierarchy = !!meta.rule_structure || !!meta.provenance_run;
    const noInjection = !/(ignore|override|bypass|skip.*check)/i.test(c.content||'');
    const noContradiction = !meta.contradicts_ref;
    const noSecret = c.sensitivity !== 'secret_detected' && !meta.secret_detected;
    return {hierarchy:hasHierarchy?0.9:0.3,injection:noInjection?0.9:0.1,contradiction:noContradiction?0.9:0.2,canary:noSecret?1:0,pass:hasHierarchy&&noInjection&&noContradiction&&noSecret};
  }

  evaluatePromotion(candidateId: string): {eligible:boolean;quality:QualityScore;benchmark:{hierarchy:number;injection:number;contradiction:number;canary:number;pass:boolean};reason:string} {
    const q = this.computeQualityScore(candidateId);
    const b = this.validateWithBenchmark(candidateId);
    const eligible = q.promotionEligible && b.pass;
    const reason = !q.promotionEligible ? 'Quality: composite='+q.composite.toFixed(2)+' disc='+q.discrimination.toFixed(2) : !b.pass ? 'Benchmark failed' : 'Eligible';
    return {eligible,quality:q,benchmark:b,reason};
  }

  createConsolidationGoal(candidateIds: string[]): GoalTemplate {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO goals (id,objective,status,risk_class,acceptance_criteria_json,budget_json,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,'Consolidate '+candidateIds.length+' similar memory candidates','created','low',
      JSON.stringify({type:'consolidation',candidate_ids:candidateIds,cosine_threshold:0.85}),
      JSON.stringify({max_runtime_ms:300000}),
      JSON.stringify({goal_type:'consolidation',candidate_count:candidateIds.length,source:'memory_evolution'}),now,now);
    return {id,objective:'Consolidate '+candidateIds.length+' candidates',goalType:'consolidation',status:'created',metadata:{candidate_ids:candidateIds},created_at:now};
  }

  createPruningGoal(candidateIds: string[]): GoalTemplate {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO goals (id,objective,status,risk_class,acceptance_criteria_json,budget_json,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,'Prune '+candidateIds.length+' memory candidates','created','low',
      JSON.stringify({type:'pruning',candidate_ids:candidateIds,weights:this.WEIGHTS}),
      JSON.stringify({max_runtime_ms:120000}),
      JSON.stringify({goal_type:'pruning',candidate_count:candidateIds.length,source:'memory_evolution'}),now,now);
    return {id,objective:'Prune '+candidateIds.length+' candidates',goalType:'pruning',status:'created',metadata:{candidate_ids:candidateIds},created_at:now};
  }

  createEvaluationGoal(candidateId: string): GoalTemplate {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO goals (id,objective,status,risk_class,acceptance_criteria_json,budget_json,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,'Evaluate memory candidate '+candidateId,'created','low',
      JSON.stringify({type:'evaluation',candidate_id:candidateId,min_composite:0.6}),
      JSON.stringify({max_runtime_ms:60000}),
      JSON.stringify({goal_type:'evaluation',candidate_id:candidateId,source:'memory_evolution'}),now,now);
    return {id,objective:'Evaluate candidate',goalType:'evaluation',status:'created',metadata:{candidate_id:candidateId},created_at:now};
  }

  getCandidatesByScope(agentId: string): string[] {
    const rows = this.db.prepare("SELECT id FROM memory_candidates WHERE json_extract(metadata,'$.agent_id')=? OR json_extract(metadata,'$.source_agent')=? OR source_ref LIKE ?").all(agentId, agentId, agentId+'%') as any[];
    return rows.map(r => r.id);
  }

  setCandidateScope(candidateId: string, agentId: string, shared: boolean): void {
    this.db.prepare("UPDATE memory_candidates SET metadata=json_set(COALESCE(metadata,'{}'),'$.agent_id',?,'.shared',?) WHERE id=?").run(agentId, shared?1:0, candidateId);
  }

}
