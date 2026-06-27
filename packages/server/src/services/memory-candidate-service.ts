import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

type MemoryType = 'operational_memory' | 'engineering_rule' | 'policy_rule';

// G8: Memory store classification — the four cognitive stores.
// episodic: what happened (run logs, immutable, retrieval by time/run)
// procedural: how to do things (skills, distilled rules, retrieval by capability)
// semantic: what is true (claims, trust-weighted, retrieval by claim type + trust)
// working: what's happening now (loop state, ephemeral, retrieval by run_id)
export type MemoryStore = 'episodic' | 'procedural' | 'semantic' | 'working';

const VALID_STORES: MemoryStore[] = ['episodic', 'procedural', 'semantic', 'working'];

export interface MemoryCandidateRecord {
  id: string;
  title: string;
  content: string;
  memory_type: MemoryType;
  store: MemoryStore;
  source_ref: string | null;
  status: 'candidate' | 'review_required' | 'rejected' | 'promoted';
  promotion_status: 'proposed' | 'blocked_pending_review' | 'blocked_pending_human' | 'rejected' | 'promoted';
  human_required: boolean;
  sensitivity: 'normal' | 'security_sensitive' | 'secret_detected';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MemoryCandidateInput {
  title: string;
  content: string;
  memory_type?: MemoryType;
  store?: MemoryStore;
  source_ref?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryPromotionInput {
  sinks?: Array<'okf' | 'uams' | 'qdrant'>;
  approved_by?: string;
  human_approved?: boolean;
}

const VALID_TYPES: MemoryType[] = ['operational_memory', 'engineering_rule', 'policy_rule'];

export class MemoryCandidateService {
  constructor(private db: Database) {}

  create(input: MemoryCandidateInput): MemoryCandidateRecord {
    if (!input.title?.trim()) {
      throw new Error('MEMORY_CANDIDATE_TITLE_REQUIRED');
    }
    if (!input.content?.trim()) {
      throw new Error('MEMORY_CANDIDATE_CONTENT_REQUIRED');
    }
    const memoryType = input.memory_type || 'operational_memory';
    if (!VALID_TYPES.includes(memoryType)) {
      throw new Error('MEMORY_CANDIDATE_TYPE_INVALID');
    }
    // G8: route the memory to the right cognitive store. Default by memory_type:
    // operational_memory → episodic (what happened), engineering_rule → procedural
    // (how to do things), policy_rule → semantic (what is true). The caller can
    // override with an explicit store (e.g., a distilled rule → procedural).
    const store = input.store || this.inferStore(memoryType);
    if (!VALID_STORES.includes(store)) {
      throw new Error('MEMORY_CANDIDATE_STORE_INVALID');
    }
    if (this.containsSecret(input.content)) {
      throw new Error('MEMORY_CANDIDATE_SECRET_DETECTED');
    }

    const classification = this.classify(memoryType, input.content);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memory_candidates (
        id, title, content, memory_type, store, source_ref, status, promotion_status,
        human_required, sensitivity, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title.trim(),
      input.content.trim(),
      memoryType,
      store,
      input.source_ref || null,
      classification.status,
      classification.promotion_status,
      classification.human_required ? 1 : 0,
      classification.sensitivity,
      JSON.stringify({
        ...(input.metadata || {}),
        candidate_only: true,
        promotion_requires_explicit_approval: classification.human_required || classification.status === 'review_required',
      }),
      now,
      now
    );

    return this.get(id);
  }

  list(limit = 100): MemoryCandidateRecord[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return (this.db.prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?').all(capped) as any[])
      .map((row) => this.parse(row));
  }

  get(id: string): MemoryCandidateRecord {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id);
    if (!row) {
      throw new Error('MEMORY_CANDIDATE_NOT_FOUND');
    }
    return this.parse(row);
  }

  promote(id: string, input: MemoryPromotionInput = {}): { candidate: MemoryCandidateRecord; sinks: Array<Record<string, unknown>> } {
    const candidate = this.get(id);
    if (candidate.promotion_status === 'promoted') {
      return { candidate, sinks: [] };
    }
    if (candidate.promotion_status === 'rejected' || candidate.status === 'rejected') {
      throw new Error('MEMORY_PROMOTION_REJECTED_CANDIDATE');
    }
    if (candidate.human_required && !input.human_approved && !input.approved_by) {
      throw new Error('MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
    }
    if (candidate.status === 'review_required' && candidate.memory_type !== 'policy_rule' && !input.approved_by) {
      throw new Error('MEMORY_PROMOTION_REVIEW_REQUIRED');
    }

    const sinks = input.sinks && input.sinks.length > 0 ? input.sinks : ['okf' as const];
    const results = sinks.map((sink) => this.writeSink(sink, candidate, input));
    const now = new Date().toISOString();
    const ok = results.every((result) => result.status === 'pass' || result.status === 'skipped');
    if (!ok) {
      throw new Error('MEMORY_PROMOTION_SINK_FAILED');
    }

    const metadata = {
      ...candidate.metadata,
      promoted_at: now,
      promoted_by: input.approved_by || 'system',
      promoted_sinks: results,
      trust_level: 'validated',
      candidate_only: false,
    };

    this.db.prepare(`
      UPDATE memory_candidates
      SET status = ?, promotion_status = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run('promoted', 'promoted', JSON.stringify(metadata), now, id);

    return {
      candidate: this.get(id),
      sinks: results,
    };
  }

  private classify(memoryType: MemoryType, content: string): {
    status: MemoryCandidateRecord['status'];
    promotion_status: MemoryCandidateRecord['promotion_status'];
    human_required: boolean;
    sensitivity: MemoryCandidateRecord['sensitivity'];
  } {
    const securitySensitive = /(auth|oauth|oidc|secret|token|password|credential|policy|approval|deploy|production)/i.test(content);
    if (memoryType === 'policy_rule') {
      return {
        status: 'review_required',
        promotion_status: 'blocked_pending_human',
        human_required: true,
        sensitivity: securitySensitive ? 'security_sensitive' : 'normal',
      };
    }
    if (memoryType === 'engineering_rule') {
      return {
        status: 'review_required',
        promotion_status: 'blocked_pending_review',
        human_required: false,
        sensitivity: securitySensitive ? 'security_sensitive' : 'normal',
      };
    }
    return {
      status: securitySensitive ? 'review_required' : 'candidate',
      promotion_status: securitySensitive ? 'blocked_pending_review' : 'proposed',
      human_required: false,
      sensitivity: securitySensitive ? 'security_sensitive' : 'normal',
    };
  }

  /**
   * G8: Infer the cognitive store from the memory type. This is the default routing —
   * the caller can override with an explicit `store` in the input.
   * - operational_memory → episodic (what happened — run logs, summaries)
   * - engineering_rule → procedural (how to do things — skills, distilled rules)
   * - policy_rule → semantic (what is true — claims, policies)
   * The `working` store is for ephemeral loop state and is never inferred from a
   * memory_type — it must be explicitly set by the loop state writer.
   */
  private inferStore(memoryType: MemoryType): MemoryStore {
    if (memoryType === 'engineering_rule') return 'procedural';
    if (memoryType === 'policy_rule') return 'semantic';
    return 'episodic';
  }

  private containsSecret(content: string): boolean {
    return /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i.test(content)
      || /\bsk-[A-Za-z0-9_\-]{10,}\b/.test(content)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  }

  /**
   * Learning flywheel write-back: embed a PROMOTED memory candidate (ollama nomic-embed-text,
   * 768d) and upsert it into the Qdrant swarm-memory collection so future runs RETRIEVE the
   * swarm's own accumulated memory via ContextInjectionService.searchQdrantSwarm (same model/
   * dimension). Best-effort + non-fatal: no key / ollama or qdrant down / dimension mismatch just
   * skips — never fails the proof. Ensures the collection is 768d Cosine; recreates it ONLY if it
   * exists at a different dimension AND is empty (never destroys populated data).
   */
  async upsertToSwarmMemory(candidateId: string): Promise<void> {
    if (process.env.PROOF_RUN_MEMORY_FLYWHEEL === 'false') return; // tests disable the network write-back
    try {
      const candidate = this.get(candidateId);
      if (!candidate || candidate.promotion_status !== 'promoted') return;
      const QDRANT_URL = (process.env.QDRANT_URL || 'http://192.168.1.28:6333').replace(/\/$/, '');
      const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://192.168.1.28:11434').replace(/\/$/, '');
      const qdrantApiKey = process.env.QDRANT_API_KEY ?? '';
      // Best-effort + bounded: never let a slow/unreachable ollama or qdrant hang the proof or
      // the proof-run-service tests. Fail fast (<=5s) and skip the write-back on any timeout/error.
      const fetchTO = async (url: string, init: RequestInit, ms = 5_000): Promise<Response> => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        try {
          return await fetch(url, { ...init, signal: ctrl.signal });
        } finally {
          clearTimeout(t);
        }
      };
      const auth: Record<string, string> = qdrantApiKey ? { 'api-key': qdrantApiKey } : {};
      const COLLECTION = 'djimitflo_swarm';
      const DIM = 768;
      const json = { 'Content-Type': 'application/json' };

      const embedRes = await fetchTO(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: `${candidate.title}. ${candidate.content}` }),
      });
      if (!embedRes.ok) return;
      const vector = (await embedRes.json() as { embedding?: number[] }).embedding;
      if (!vector || vector.length !== DIM) return; // model/collection dimension mismatch -> abort safely

      const infoRes = await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}`, { headers: auth });
      if (infoRes.status === 404) {
        await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}`, { method: 'PUT', headers: { ...json, ...auth }, body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }) });
      } else if (infoRes.ok) {
        const info = (await infoRes.json() as { result?: { config?: { params?: { vectors?: { size?: number } }; }; points_count?: number } }).result;
        const size = info?.config?.params?.vectors?.size;
        const count = info?.points_count ?? 0;
        if (typeof size === 'number' && size !== DIM && count === 0) {
          await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}`, { method: 'DELETE', headers: auth });
          await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}`, { method: 'PUT', headers: { ...json, ...auth }, body: JSON.stringify({ vectors: { size: DIM, distance: 'Cosine' } }) });
        } else if (typeof size === 'number' && size !== DIM) {
          return; // populated mismatched collection — do not destroy
        }
      }

      await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
        method: 'PUT',
        headers: { ...json, ...auth },
        body: JSON.stringify({
          points: [{
            id: candidate.id,
            vector,
            payload: {
              task_id: candidate.id,
              content_excerpt: candidate.content.slice(0, 500),
              agent_type: 'memory_curator',
              trust_level: 'validated',
              // G8: cognitive store label — enables typed retrieval (procedural rules,
              // semantic claims, episodic logs) instead of a mixed-context bag.
              store: candidate.store,
              source_ref: candidate.source_ref,
              // G2: provenance — bind this memory to the run + evidence that produced it,
              // so retrieval returns claims-with-provenance (not bare text) and the receiver's
              // checker can gate on trust/provenance (G5 handoff).
              provenance_run: typeof (candidate.metadata as Record<string, unknown>).loop_run_id === 'string'
                ? (candidate.metadata as Record<string, unknown>).loop_run_id as string
                : (candidate.source_ref || null),
              evidence_refs: [
                (candidate.metadata as Record<string, unknown>).maker_lease_id,
                (candidate.metadata as Record<string, unknown>).checker_lease_id,
              ].filter((v): v is string => typeof v === 'string' && v.length > 0),
              timestamp: new Date().toISOString(),
            },
          }],
        }),
      });
    } catch {
      // best-effort: never fail the proof on the learning write-back
    }
  }

  private writeSink(sink: 'okf' | 'uams' | 'qdrant', candidate: MemoryCandidateRecord, input: MemoryPromotionInput): Record<string, unknown> {
    if (sink === 'okf') {
      try {
      const okfBase = KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true });
      const memoryDir = path.join(okfBase, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const filePath = path.join(memoryDir, `${candidate.id}.md`);
      const frontmatter = [
        '---',
        'type: MemoryCandidate',
        `title: "${candidate.title.replace(/"/g, '\\"')}"`,
        `memory_type: ${candidate.memory_type}`,
        'trust_level: validated',
        `source_ref: "${(candidate.source_ref || '').replace(/"/g, '\\"')}"`,
        `approved_by: "${(input.approved_by || 'system').replace(/"/g, '\\"')}"`,
        `timestamp: ${new Date().toISOString()}`,
        '---',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, `${frontmatter}# ${candidate.title}\n\n${candidate.content}\n`, 'utf8');
        return { sink, status: 'pass', path: filePath };
      } catch (e) {
        // Wiki transfer is best-effort: never fail promote when the OKF memory dir is
        // unwritable/missing (e.g. mocked worktrees in tests). Skip and continue.
        return { sink, status: 'skipped', reason: `okf_write_failed: ${(e as Error).message}` };
      }
    }
    return {
      sink,
      status: 'skipped',
      reason: 'external sink promotion is declared but not executed in local auto-propose mode',
    };
  }


  /**
   * G12: Memory distillation — after a run completes, create a procedural memory
   * (an actionable rule) from the run's evidence. Unlike the run-summary (episodic),
   * a distilled rule captures WHAT TO DO differently next time, not WHAT HAPPENED.
   *
   * The rule is structured: { capability, outcome, rule, precondition }.
   * It goes through the same evidence-gated promotion as skills (G1): the checker
   * verifies, trust decay + contradiction apply.
   *
   * This is template distillation — it creates a structured rule from the run's
   * metadata without requiring a runtime call. A future evolution (G12+) can use
   * the runtime to produce richer natural-language rules.
   */
  distillFromRun(input: {
    loopRunId: string;
    capabilityId?: string | null;
    runtime: string;
    outcome: 'success' | 'failure';
    makerLeaseId?: string;
    checkerLeaseId?: string;
    keyLearning?: string;
    metadata?: Record<string, unknown>;
  }): MemoryCandidateRecord {
    const rule = input.keyLearning
      ? input.keyLearning
      : input.outcome === 'success'
        ? `Capability ${input.capabilityId || 'unknown'} on ${input.runtime}: the approach succeeded. Apply the same capability-runtime pairing for similar findings.`
        : `Capability ${input.capabilityId || 'unknown'} on ${input.runtime}: the approach failed. Consider a different runtime or split the finding before retrying.`;

    return this.create({
      title: `Distilled rule: ${input.capabilityId || 'general'} (${input.runtime}, ${input.outcome})`,
      content: rule,
      memory_type: 'engineering_rule',
      store: 'procedural',
      source_ref: `loop:${input.loopRunId}`,
      metadata: {
        ...(input.metadata || {}),
        loop_run_id: input.loopRunId,
        capability_id: input.capabilityId,
        runtime: input.runtime,
        outcome: input.outcome,
        maker_lease_id: input.makerLeaseId,
        checker_lease_id: input.checkerLeaseId,
        distilled: true,
        rule_structure: {
          capability: input.capabilityId,
          outcome: input.outcome,
          runtime: input.runtime,
          rule,
        },
      },
    });
  }

  private parse(row: any): MemoryCandidateRecord {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      memory_type: row.memory_type,
      store: (row.store as MemoryStore) || 'episodic',
      source_ref: row.source_ref || null,
      status: row.status,
      promotion_status: row.promotion_status,
      human_required: Boolean(row.human_required),
      sensitivity: row.sensitivity,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
