import type { Database } from 'better-sqlite3';
import { WorkItemService, type RiskClass, type WorkItemCreateInput, type WorkItemRecord } from './work-item-service';
import type { LoopName } from './loop-service';

type IntegrationSource = 'github_issue' | 'telegram_command' | 'mcp_drift' | 'okf_drift' | 'dashboard_action';

const VALID_SOURCES: IntegrationSource[] = ['github_issue', 'telegram_command', 'mcp_drift', 'okf_drift', 'dashboard_action'];
const VALID_RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const VALID_LOOPS: LoopName[] = [
  'doc-drift-and-small-fix-loop',
  'repo-maintenance-loop',
  'skill-quality-loop',
  'mcp-connector-validation-loop',
  'security-regression-loop',
  'okf-synchronization-loop',
  'overwatch-policy-drift-loop',
];

export interface IntegrationInboxInput {
  source: IntegrationSource;
  source_ref?: string | null;
  title: string;
  description: string;
  risk_class?: RiskClass;
  recommended_loop?: LoopName | null;
  value_score?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface IntegrationInboxPreview {
  dry_run: boolean;
  blocked_reasons: string[];
  work_item_input: WorkItemCreateInput;
}

export interface IntegrationInboxImportResult extends IntegrationInboxPreview {
  dry_run: false;
  created: boolean;
  work_item: WorkItemRecord;
}

export class IntegrationInboxService {
  private workItems: WorkItemService;

  constructor(private db: Database) {
    this.workItems = new WorkItemService(db);
  }

  preview(input: IntegrationInboxInput): IntegrationInboxPreview {
    const workItemInput = this.normalize(input);
    const blockedReasons = this.connectorBlockedReasons(input, workItemInput.risk_class || 'low');
    if (blockedReasons.length) {
      workItemInput.status = 'blocked';
      workItemInput.metadata = {
        ...(workItemInput.metadata || {}),
        integration: {
          ...this.objectMetadata(workItemInput.metadata?.integration),
          blocked_reasons: blockedReasons,
        },
      };
    }
    return {
      dry_run: true,
      blocked_reasons: blockedReasons,
      work_item_input: workItemInput,
    };
  }

  importEvent(input: IntegrationInboxInput): IntegrationInboxImportResult {
    const preview = this.preview(input);
    const result = this.workItems.upsertBySourceRef(preview.work_item_input);
    return {
      ...preview,
      dry_run: false,
      created: result.created,
      work_item: result.work_item,
    };
  }

  private normalize(input: IntegrationInboxInput): WorkItemCreateInput {
    if (!VALID_SOURCES.includes(input.source)) throw new Error('INTEGRATION_SOURCE_INVALID');
    if (!input.title?.trim()) throw new Error('INTEGRATION_TITLE_REQUIRED');
    if (!input.description?.trim()) throw new Error('INTEGRATION_DESCRIPTION_REQUIRED');
    if (input.risk_class && !VALID_RISKS.includes(input.risk_class)) throw new Error('INTEGRATION_RISK_INVALID');
    if (input.recommended_loop && !VALID_LOOPS.includes(input.recommended_loop)) throw new Error('INTEGRATION_LOOP_INVALID');

    const sourceRef = input.source_ref?.trim() || this.fallbackSourceRef(input);
    return {
      title: input.title.trim(),
      description: input.description.trim(),
      source: input.source,
      source_ref: sourceRef,
      risk_class: input.risk_class || 'low',
      value_score: input.value_score ?? this.defaultValueScore(input.source),
      confidence: input.confidence ?? 0.75,
      status: 'triaged',
      recommended_loop: input.recommended_loop || this.defaultLoop(input.source),
      metadata: {
        ...(input.metadata || {}),
        integration: {
          source: input.source,
          source_ref: sourceRef,
          received_at: new Date().toISOString(),
          ...(this.objectMetadata(input.metadata?.integration) || {}),
        },
      },
    };
  }

  private fallbackSourceRef(input: IntegrationInboxInput): string {
    return `${input.source}:${input.title.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`;
  }

  private defaultLoop(source: IntegrationSource): LoopName {
    if (source === 'mcp_drift') return 'mcp-connector-validation-loop';
    if (source === 'okf_drift') return 'okf-synchronization-loop';
    return 'repo-maintenance-loop';
  }

  private defaultValueScore(source: IntegrationSource): number {
    if (source === 'github_issue') return 85;
    if (source === 'mcp_drift' || source === 'okf_drift') return 80;
    return 70;
  }

  private connectorBlockedReasons(input: IntegrationInboxInput, riskClass: RiskClass): string[] {
    const integration = this.objectMetadata(input.metadata?.integration);
    const capabilityId = typeof integration?.capability_id === 'string' ? integration.capability_id : undefined;
    const toolId = typeof integration?.mcp_tool_id === 'string' ? integration.mcp_tool_id : undefined;
    const blocked: string[] = [];

    if (capabilityId) {
      const row = this.db.prepare('SELECT status, risk_ceiling, eval_score, eval_threshold FROM swarm_capabilities WHERE id = ?').get(capabilityId) as any | undefined;
      if (!row) {
        blocked.push('capability_not_found');
      } else {
        if (row.status !== 'validated') blocked.push('capability_not_validated');
        if (Number(row.eval_score) < Number(row.eval_threshold)) blocked.push('capability_eval_below_threshold');
        if (!this.riskCovers(row.risk_ceiling, riskClass)) blocked.push('capability_risk_ceiling_exceeded');
      }
    }

    if (toolId) {
      const row = this.db.prepare('SELECT permission, risk_level FROM mcp_tools WHERE id = ?').get(toolId) as any | undefined;
      if (!row) {
        blocked.push('mcp_tool_not_found');
      } else {
        if (row.permission !== 'allowed') blocked.push(`mcp_tool_${row.permission}`);
        if (!this.riskCovers(row.risk_level, riskClass)) blocked.push('mcp_tool_risk_exceeded');
      }
    }

    return blocked;
  }

  private riskCovers(ceiling: string, riskClass: RiskClass): boolean {
    const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
    return rank[ceiling as RiskClass] >= rank[riskClass];
  }

  private objectMetadata(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
}
