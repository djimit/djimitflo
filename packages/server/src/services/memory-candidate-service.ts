import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { yamlScalar } from '../utils/yaml-scalar';
import { findTemplateMatches, memoryTemplateDedupMode, recordTemplateDedupError, recordTemplateDuplicate, templateFingerprint } from './memory-template-dedup';
import { ensureCollection, memoryEmbedModel, SWARM_MEMORY_COLLECTION } from './memory-embedding-contract';

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
  /** F5: the session user who pressed promote — recorded as promoted_by; unlike approved_by it never satisfies a review gate */
  actor?: string;
  /**
   * P0-9: the authenticated user id (route layer: req.user.sub). Only human_approved + this id satisfies a human_required
   * gate; an approved_by string (machine callers such as proof-run or the review scheduler) never does.
   */
  approver_user_id?: string;
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

    // Intervention 3: template-duplicate check (MEMORY_TEMPLATE_DEDUP_MODE, default off). shadow records a judgment and
    // still creates; enforce returns the newest existing match instead of creating. Nothing is ever deleted or promoted here.
    // Fails open in every mode: an error in fingerprint / lookup / judgment never blocks or skips a candidate.
    const dedupMode = memoryTemplateDedupMode();
    let templateDup: { fingerprint: string; matches: Array<{ id: string; status: string }> } | null = null;
    let dedupError: { stage: 'lookup' | 'enforce'; error: unknown } | null = null;
    if (dedupMode !== 'off') {
      try {
        const fingerprint = templateFingerprint(input.content.trim());
        const matches = findTemplateMatches(this.db, fingerprint);
        if (matches.length > 0) templateDup = { fingerprint, matches };
      } catch (error) {
        templateDup = null;
        dedupError = { stage: 'lookup', error };
      }
      if (templateDup && dedupMode === 'enforce') {
        try {
          const existing = this.get(templateDup.matches[0].id);
          recordTemplateDuplicate(this.db, { subjectId: existing.id, fingerprint: templateDup.fingerprint, mode: 'enforce', matches: templateDup.matches, sourceRef: input.source_ref || null });
          return existing;
        } catch (error) {
          templateDup = null; // fail open: create normally
          dedupError = { stage: 'enforce', error };
        }
      }
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

    if (dedupError) recordTemplateDedupError(this.db, { mode: dedupMode, stage: dedupError.stage, error: dedupError.error, subjectId: id, sourceRef: input.source_ref || null });
    if (templateDup) {
      try {
        recordTemplateDuplicate(this.db, { subjectId: id, fingerprint: templateDup.fingerprint, mode: 'shadow', matches: templateDup.matches, sourceRef: input.source_ref || null });
      } catch (error) {
        recordTemplateDedupError(this.db, { mode: dedupMode, stage: 'record', error, subjectId: id, sourceRef: input.source_ref || null });
      }
    }
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

  /**
   * Candidates eligible for unattended promotion: classify() only assigns
   * status='candidate'/promotion_status='proposed' to non-sensitive
   * operational_memory — engineering_rule/policy_rule/security-sensitive
   * content is classified straight into 'review_required'/
   * 'blocked_pending_human' and never appears here, so this list is already
   * safe for an automated caller to attempt promote() on without a human.
   */
  listPendingPromotion(limit = 200): MemoryCandidateRecord[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return (this.db.prepare(
      "SELECT * FROM memory_candidates WHERE status = 'candidate' AND promotion_status = 'proposed' ORDER BY created_at ASC LIMIT ?"
    ).all(capped) as any[]).map((row) => this.parse(row));
  }

  /** Persists which specialist panel is reviewing this candidate, so a scheduler can reuse it across ticks instead of creating a new one each time. */
  setReviewPanel(id: string, panelId: string): MemoryCandidateRecord {
    const candidate = this.get(id);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE memory_candidates SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...candidate.metadata, review_panel_id: panelId }), now, id);
    return this.get(id);
  }

  /**
   * The panel reviewed this candidate and did not reach 'goal' consensus.
   * Moves promotion_status off 'proposed' so it stops looking like it's
   * still awaiting its first review — mirrors the self-improvement pipeline's
   * identical gap (SelfImprovementService.agentApproveIfReady), found in
   * production with 104 proposals silently parked at 'proposed' for up to
   * 6 days after review. Reuses the existing 'blocked_pending_review' value
   * (same one classify() already assigns to engineering_rule candidates)
   * rather than adding a new promotion_status — the column has a CHECK
   * constraint, and this candidate's situation is exactly that: reviewed,
   * blocked, not a hard rejection.
   */
  markNeedsMoreEvidence(id: string): MemoryCandidateRecord {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memory_candidates SET promotion_status = 'blocked_pending_review', updated_at = ? WHERE id = ?")
      .run(now, id);
    return this.get(id);
  }

  /** Operator memory review (S2/U4): a human rejects a candidate; who and why are kept in its metadata. */
  reject(id: string, actor: string, reason = ''): MemoryCandidateRecord {
    const candidate = this.get(id);
    if (candidate.status === 'promoted' || candidate.promotion_status === 'promoted') throw new Error('MEMORY_REJECT_ALREADY_PROMOTED');
    if (!actor.trim()) throw new Error('MEMORY_REJECT_ACTOR_REQUIRED');
    const now = new Date().toISOString();
    const metadata = { ...candidate.metadata, rejected_at: now, rejected_by: actor, rejected_reason: reason.slice(0, 300) };
    this.db.prepare(`UPDATE memory_candidates SET status = 'rejected', promotion_status = 'rejected', metadata = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), now, id);
    return this.get(id);
  }

  promote(id: string, input: MemoryPromotionInput = {}): { candidate: MemoryCandidateRecord; sinks: Array<Record<string, unknown>> } {
    const candidate = this.get(id);
    if (candidate.promotion_status === 'promoted') {
      return { candidate, sinks: [] };
    }
    if (candidate.promotion_status === 'rejected' || candidate.status === 'rejected') {
      throw new Error('MEMORY_PROMOTION_REJECTED_CANDIDATE');
    }
    const humanApproval = input.human_approved === true && typeof input.approver_user_id === 'string' && input.approver_user_id.length > 0;
    if (candidate.human_required && !humanApproval) {
      throw new Error('MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
    }
    if (candidate.status === 'review_required' && candidate.memory_type !== 'policy_rule' && !input.approved_by) {
      throw new Error('MEMORY_PROMOTION_REVIEW_REQUIRED');
    }

    const sinks = input.sinks && input.sinks.length > 0 ? input.sinks : ['okf' as const];
    const results = sinks.map((sink) => this.writeSink(sink, candidate, input));
    const now = new Date().toISOString();
    const ok = results.every((result) => result.status === 'pass' || result.status === 'skipped' || result.status === 'pending_async');
    if (!ok) {
      throw new Error('MEMORY_PROMOTION_SINK_FAILED');
    }

    const metadata = {
      ...candidate.metadata,
      promoted_at: now,
      promoted_by: input.approved_by || input.actor || 'system',
      // P0-9: who approved, by kind — a machine approved_by string is never recorded as a human approval
      approver_type: humanApproval ? 'human' : 'machine',
      ...(humanApproval ? { approver_user_id: input.approver_user_id } : {}),
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
   * Learning flywheel write-back: embed a PROMOTED memory candidate with the shared memory
   * embedding contract (memory-embedding-contract.ts) and upsert it into the Qdrant swarm-memory
   * collection so future runs RETRIEVE the swarm's own accumulated memory via
   * ContextInjectionService.searchQdrantSwarm (same model/dimension). Best-effort + non-fatal: no
   * key / ollama or qdrant down / dimension mismatch just skips — never fails the proof. Creates
   * the collection only when it is absent (404); never deletes or recreates one (CODE-001).
   */
  async upsertToSwarmMemory(candidateId: string): Promise<{ ok: boolean; reason?: string }> {
    if (process.env.PROOF_RUN_MEMORY_FLYWHEEL === 'false') return { ok: false, reason: 'flywheel_disabled_by_env' };
    try {
      const candidate = this.get(candidateId);
      if (!candidate || candidate.promotion_status !== 'promoted') return { ok: false, reason: 'candidate_not_found_or_not_promoted' };
      const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/$/, '');
      const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
      if (!QDRANT_URL || !OLLAMA_URL) return { ok: false, reason: 'qdrant_or_ollama_url_unset' };
      const qdrantApiKey = process.env.QDRANT_API_KEY ?? '';
      // Best-effort + bounded: never let a slow/unreachable ollama or qdrant hang the proof or
      // the proof-run-service tests. Fail fast (<=5s) and skip the write-back on any timeout/error.
      // STATE-03: AbortSignal.timeout keeps the deadline on the body read too (a cleared timer did not).
      const fetchTO = (url: string, init: RequestInit, ms = 5_000): Promise<Response> =>
        fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
      const auth: Record<string, string> = qdrantApiKey ? { 'api-key': qdrantApiKey } : {};
      const COLLECTION = SWARM_MEMORY_COLLECTION;
      const model = memoryEmbedModel(); // CODE-002: same model as memory-sync writes and context injection reads
      const json = { 'Content-Type': 'application/json' };

      const embedRes = await fetchTO(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ model, prompt: `${candidate.title}. ${candidate.content}` }),
      });
      if (!embedRes.ok) return { ok: false, reason: `ollama_embed_failed:${embedRes.status}` };
      const vector = (await embedRes.json() as { embedding?: number[] }).embedding;
      if (!vector?.length) return { ok: false, reason: 'ollama_embedding_empty' };

      // CODE-001: never DELETE/recreate an existing collection; only a 404 is created.
      const state = await ensureCollection(QDRANT_URL, COLLECTION, { ...json, ...auth }, vector.length, model);
      if (state.status !== 'ready') return { ok: false, reason: `qdrant_unavailable:${state.reason}` };

      const upsertRes = await fetchTO(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
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
              embedding_model: model, embedding_dim: vector.length, // UX-21
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
      if (!upsertRes.ok) return { ok: false, reason: `qdrant_upsert_failed:${upsertRes.status}` };
      return { ok: true };
    } catch (e) {
      // best-effort: fail-closed — surface the reason so callers can flag degraded state
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `exception:${reason.slice(0, 100)}` };
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
        `title: ${yamlScalar(candidate.title)}`,
        `memory_type: ${candidate.memory_type}`,
        'trust_level: validated',
        `source_ref: ${yamlScalar(candidate.source_ref)}`,
        `approved_by: ${yamlScalar(input.approved_by || input.actor || 'system')}`,
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
    if (sink === 'qdrant') {
      // ponytail: qdrant write is async (embed + upsert); promote() is sync. The real write lives in
      // upsertToSwarmMemory — callers invoke it immediately after promote(). Mark as pending_async
      // so promoted_sinks metadata is honest about the deferred path. Ceiling: if promote() ever
      // becomes async, move the upsert here and flip status to pass/fail.
      return { sink, status: 'pending_async', reason: 'async write deferred to upsertToSwarmMemory' };
    }
    if (sink === 'uams') {
      // uams bridge not wired here; surface as a real skip, not a fake success.
      return { sink, status: 'skipped', reason: 'uams sink not wired in local auto-propose mode' };
    }
    return {
      sink,
      status: 'skipped',
      reason: `unknown sink: ${sink}`,
    };
  }


  /**
   * G12: Memory distillation — after a run completes, create a procedural memory
   * (an actionable rule) from the run's evidence. Unlike the run-summary (episodic),
   * a distilled rule captures WHAT TO DO differently next time, not WHAT HAPPENED.
   *
   * The rule is structured: { capability, outcome, rule, precondition }.
   * T12.4: The rule goes through the SAME evidence-gated promotion as skills (G1):
   * it's created as memory_type='engineering_rule' → status='review_required' →
   * promotion_status='blocked_pending_review'. It must be explicitly promoted
   * (via promote()) before it's trusted + written to the vector store. Trust decay
   * (30-day half-life) + contradiction (contradicts_ref) apply once promoted.
   * This closes the memory-poisoning surface: a bad rule can't be injected at full
   * trust without review.
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
