import crypto from 'crypto';
import fs from 'fs';
import type { Database } from 'better-sqlite3';
import type { WorkItemCreateInput } from './work-item-service';

export interface NasEvidencePacket {
  source_path: string;
  title: string;
  domain: string;
  claim: string;
  confidence: number;
  valid_until: string | null;
  risk_flags: string[];
}

export interface NasEvidenceSummary {
  status: 'green' | 'amber' | 'red';
  packets_path: string | null;
  audit_path: string | null;
  blocked_path: string | null;
  approved_packets: number;
  blocked_entries: number;
  needs_redaction: number;
  oldest_valid_until: string | null;
  blocked_reasons: string[];
}

export interface NasEvidenceImportPreview {
  dry_run: true;
  create: number;
  existing: number;
  blocked: number;
  work_items: Array<WorkItemCreateInput & { exists: boolean }>;
  blocked_reasons: string[];
}

export class NasEvidenceService {
  constructor(private db: Database, private paths = defaultPaths()) {}

  summary(): NasEvidenceSummary {
    const packets = this.readPackets();
    const blocked = this.readBlocked();
    const blockedReasons = [...packets.errors, ...blocked.errors];
    const needsRedaction = blocked.rows.filter((row) => row.blocked_reasons?.some((reason: string) => reason.includes('needs-redaction'))).length;
    const oldestValidUntil = packets.rows
      .map((packet) => packet.valid_until)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
    const rawExport = packets.rows.some((packet) => /(?:chatgpt|claude) export/i.test(packet.source_path));
    if (rawExport) blockedReasons.push('NAS_EVIDENCE_RAW_EXPORT_PACKET');

    return {
      status: blockedReasons.length > 0 ? 'red' : needsRedaction > 0 ? 'amber' : 'green',
      packets_path: this.paths.packets,
      audit_path: this.paths.audit,
      blocked_path: this.paths.blocked,
      approved_packets: packets.rows.length,
      blocked_entries: blocked.rows.length,
      needs_redaction: needsRedaction,
      oldest_valid_until: oldestValidUntil,
      blocked_reasons: [...new Set(blockedReasons)],
    };
  }

  importPreview(): NasEvidenceImportPreview {
    const summary = this.summary();
    const packets = this.readPackets();
    const blockedReasons = [...summary.blocked_reasons, ...packets.errors];
    const workItems = packets.rows.flatMap((packet) => {
      if (/(?:chatgpt|claude) export/i.test(packet.source_path)) return [];
      const input = this.workItemFromPacket(packet);
      return [{ ...input, exists: this.exists(input.source!, input.source_ref!) }];
    });
    return {
      dry_run: true,
      create: workItems.filter((item) => !item.exists).length,
      existing: workItems.filter((item) => item.exists).length,
      blocked: blockedReasons.length,
      work_items: workItems,
      blocked_reasons: [...new Set(blockedReasons)],
    };
  }

  private workItemFromPacket(packet: NasEvidencePacket): WorkItemCreateInput {
    const sourceRef = crypto.createHash('sha256').update(`${packet.source_path}\0${packet.claim}\0${packet.valid_until ?? ''}`).digest('hex');
    return {
      title: `NAS: ${packet.title}`,
      description: `${packet.claim}\n\nSource: ${packet.source_path}\nValid until: ${packet.valid_until ?? 'n/a'}`,
      source: 'nas_evidence_packet',
      source_ref: sourceRef,
      risk_class: packet.domain.includes('threat') ? 'medium' : 'low',
      value_score: packet.domain === 'djimitflo' ? 80 : 70,
      confidence: packet.confidence,
      status: 'candidate',
      recommended_loop: packet.domain.includes('threat') ? 'security-intelligence' : 'knowledge-curation',
      metadata: { ...packet, dry_run_source: true },
    };
  }

  private exists(source: string, sourceRef: string): boolean {
    return Boolean(this.db.prepare('SELECT id FROM work_items WHERE source = ? AND source_ref = ?').get(source, sourceRef));
  }

  private readPackets(): { rows: NasEvidencePacket[]; errors: string[] } {
    return this.readJsonl<NasEvidencePacket>(this.paths.packets, validatePacket, 'NAS_EVIDENCE_PACKETS');
  }

  private readBlocked(): { rows: Array<{ blocked_reasons?: string[] }>; errors: string[] } {
    return this.readJsonl(this.paths.blocked, validateBlocked, 'NAS_EVIDENCE_BLOCKED');
  }

  private readJsonl<T>(file: string | null, validate: (row: any) => row is T, label: string): { rows: T[]; errors: string[] } {
    if (!file) return { rows: [], errors: [`${label}_PATH_MISSING`] };
    if (!fs.existsSync(file)) return { rows: [], errors: [`${label}_FILE_MISSING`] };
    try {
      const rows = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(validate);
      return { rows, errors: [] };
    } catch {
      return { rows: [], errors: [`${label}_INVALID_JSONL`] };
    }
  }
}

function defaultPaths() {
  return {
    packets: process.env.NAS_EVIDENCE_PACKETS_PATH || null,
    audit: process.env.NAS_EVIDENCE_AUDIT_PATH || null,
    blocked: process.env.NAS_EVIDENCE_BLOCKED_PATH || null,
  };
}

function validatePacket(row: any): row is NasEvidencePacket {
  return Boolean(row?.source_path && row?.title && row?.domain && row?.claim && typeof row.confidence === 'number' && Array.isArray(row.risk_flags));
}

function validateBlocked(row: any): row is { blocked_reasons?: string[] } {
  return Boolean(row && typeof row === 'object');
}
