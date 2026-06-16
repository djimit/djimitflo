import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

type MemoryType = 'operational_memory' | 'engineering_rule' | 'policy_rule';

export interface MemoryCandidateRecord {
  id: string;
  title: string;
  content: string;
  memory_type: MemoryType;
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
    if (this.containsSecret(input.content)) {
      throw new Error('MEMORY_CANDIDATE_SECRET_DETECTED');
    }

    const classification = this.classify(memoryType, input.content);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO memory_candidates (
        id, title, content, memory_type, source_ref, status, promotion_status,
        human_required, sensitivity, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title.trim(),
      input.content.trim(),
      memoryType,
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

  private containsSecret(content: string): boolean {
    return /(api[_-]?key|secret|token|password)\s*=\s*['"]?[A-Za-z0-9_\-]{12,}/i.test(content)
      || /\bsk-[A-Za-z0-9_\-]{10,}\b/.test(content)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  }

  private writeSink(sink: 'okf' | 'uams' | 'qdrant', candidate: MemoryCandidateRecord, input: MemoryPromotionInput): Record<string, unknown> {
    if (sink === 'okf') {
      const okfBase = process.env.OKF_BASE || path.resolve(__dirname, '../../../knowledge');
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
    }

    return {
      sink,
      status: 'skipped',
      reason: 'external sink promotion is declared but not executed in local auto-propose mode',
    };
  }


  private parse(row: any): MemoryCandidateRecord {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      memory_type: row.memory_type,
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
