import type { Database } from 'better-sqlite3';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { SelfModelService } from './self-model-service';
import type { LoopName } from './loop-service';

export interface LoopFinding {
  id: string;
  type: string;
  severity: string;
  file: string;
  message: string;
  evidence: string;
  suggested_fix: string;
}

export interface GoalRecord {
  id: string;
  objective: string;
  status: string;
  risk_class: string;
  created_at: string;
  updated_at: string;
}

export interface GoalCreateInput {
  objective: string;
  risk_class?: string;
  repository_path?: string;
  acceptance_criteria?: string[];
}

export interface RuntimeContract {
  name: string;
  trigger: string[];
  context_sources: string[];
  actions_allowed: string[];
  actions_forbidden: string[];
  verification: string[];
}

export class LoopPlanningService {
  constructor(
    _db: Database,
    private intelligence: SwarmIntelligenceService,
    private selfModel: SelfModelService,
  ) {}

  selectRuntimeForCapability(capabilityId: string): string {
    try {
      const calibration = this.selfModel.getCalibration(capabilityId);
      if (calibration.nRuns >= 3) {
        return calibration.recommendedConfidence > 0.5 ? 'codex' : 'opencode';
      }
    } catch { /* fallback */ }
    return 'codex';
  }

  discoverFindings(loopName: LoopName, _repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];

    try {
      const capabilities = this.intelligence.listCapabilities();
      const validatedCaps = capabilities.filter(c => c.status === 'validated').slice(0, maxFindings);

      for (const cap of validatedCaps) {
        findings.push({
          id: `finding-${cap.id}-${Date.now()}`,
          type: cap.kind,
          severity: 'info',
          file: '<capability>',
          message: `Capability "${cap.id}" available for ${loopName}`,
          evidence: `Validated capability with ${cap.status} status`,
          suggested_fix: `Consider using capability "${cap.id}"`,
        });
      }
    } catch { /* best-effort */ }

    return findings.slice(0, maxFindings);
  }

  getLoopContract(name: string): RuntimeContract {
    const contracts: Record<string, RuntimeContract> = {
      'doc-drift-and-small-fix-loop': {
        name: 'doc-drift-and-small-fix-loop',
        trigger: ['doc_drift', 'small_fix'],
        context_sources: ['repository_files', 'okf_memory'],
        actions_allowed: ['read', 'analyze', 'fix', 'document'],
        actions_forbidden: ['deploy', 'merge', 'push'],
        verification: ['test', 'lint', 'type_check'],
      },
      'research-loop': {
        name: 'research-loop',
        trigger: ['research_question', 'knowledge_gap'],
        context_sources: ['wikipedia', 'arxiv', 'okf_memory', 'djimitkb'],
        actions_allowed: ['search', 'read', 'synthesize', 'cite'],
        actions_forbidden: ['deploy', 'merge', 'push'],
        verification: ['source_quality', 'logical_consistency'],
      },
    };
    return contracts[name] || { name, trigger: [], context_sources: [], actions_allowed: [], actions_forbidden: [], verification: [] };
  }

  getAvailableRuntimes(): string[] {
    return ['codex', 'opencode', 'pi', 'claude', 'gemini', 'editor', 'mock'];
  }

  getCapabilityCoverage(): Record<string, number> {
    const coverage: Record<string, number> = {};
    try {
      const capabilities = this.intelligence.listCapabilities();
      for (const cap of capabilities) {
        if (cap.status === 'validated') {
          coverage[cap.id] = 1;
        }
      }
    } catch { /* best-effort */ }
    return coverage;
  }
}
