/**
 * NlAgentFactory — natural language driven agent creation.
 *
 * Converts NL descriptions into structured agent configurations.
 * Generated agents are created with status='pending_approval' and must be
 * explicitly activated by a human operator.
 *
 * v1 uses template-based generation (deterministic, no LLM dependency).
 * v2 will integrate with LiteLLM for intelligent config generation.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AgentConfig {
  name: string;
  description: string;
  agent_type: string;
  capabilities: string[];
  risk_class: 'low' | 'medium' | 'high';
  model: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
  tools: string[];
  metadata: Record<string, unknown>;
}

export interface NlAgentCreationResult {
  id: string;
  config: AgentConfig;
  status: 'pending_approval';
  draft: true;
  created_at: string;
}

const AGENT_TYPE_PATTERNS: Array<{ pattern: RegExp; type: string; capabilities: string[] }> = [
  { pattern: /security|scan|vulnerab|owasp|penetration/i, type: 'security', capabilities: ['security-scanning', 'vulnerability-assessment', 'compliance-checking'] },
  { pattern: /code.*review|review.*code|pull.*request|pr.*review/i, type: 'code-reviewer', capabilities: ['code-review', 'static-analysis', 'quality-gate'] },
  { pattern: /test|spec|coverage|qa/i, type: 'test-engineer', capabilities: ['test-generation', 'test-execution', 'coverage-analysis'] },
  { pattern: /deploy|release|ship|publish/i, type: 'deployer', capabilities: ['deployment', 'rollback', 'release-management'] },
  { pattern: /research|search|investigat|analyz/i, type: 'researcher', capabilities: ['web-search', 'analysis', 'synthesis'] },
  { pattern: /document|doc|wiki|readme/i, type: 'documenter', capabilities: ['documentation', 'wiki-management', 'readme-generation'] },
  { pattern: /monitor|observ|alert|health/i, type: 'monitor', capabilities: ['monitoring', 'alerting', 'health-checks'] },
  { pattern: /data|etl|pipeline|transform/i, type: 'data-engineer', capabilities: ['data-processing', 'etl', 'pipeline-management'] },
  { pattern: /infra|server|host|machine|workstation/i, type: 'infrastructure', capabilities: ['server-management', 'provisioning', 'configuration'] },
  { pattern: /orchestrat|coordinat|manage|control/i, type: 'orchestrator', capabilities: ['task-delegation', 'coordination', 'scheduling'] },
];

function inferAgentType(description: string): { type: string; capabilities: string[] } {
  for (const { pattern, type, capabilities } of AGENT_TYPE_PATTERNS) {
    if (pattern.test(description)) {
      return { type, capabilities };
    }
  }
  return { type: 'generalist', capabilities: ['task-execution', 'reporting'] };
}

function inferRiskClass(description: string, _capabilities: string[]): 'low' | 'medium' | 'high' {
  if (/security|vulnerab|production|deploy/i.test(description)) return 'high';
  if (/delete|remove|overwrite|force/i.test(description)) return 'high';
  if (/write|modify|create|send/i.test(description)) return 'medium';
  return 'low';
}

function generateSystemPrompt(config: AgentConfig): string {
  return `You are ${config.name}, a ${config.agent_type} agent.

${config.description}

Your capabilities: ${config.capabilities.join(', ')}

## Operating Principles
- You operate within the DjimFlo agent orchestration control plane.
- All actions are audited, evidence-gated, and require human approval for high-risk operations.
- You emit structured evidence for every action you take.
- You respect the configured risk class: ${config.risk_class}.

## Boundaries
- Do not perform destructive operations without explicit human approval.
- Do not exfiltrate secrets or credentials.
- Do not modify production systems without a review bundle.
- Always emit trace evidence for observability.`;
}

export class NlAgentFactory {
  constructor(private db: Database) {}

  /**
   * Create an agent configuration from a natural language description.
   * The agent is created with status='pending_approval'.
   */
  createFromDescription(description: string, options: {
    name?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  } = {}): NlAgentCreationResult {
    if (!description?.trim()) {
      throw new Error('AGENT_DESCRIPTION_REQUIRED');
    }

    const inferred = inferAgentType(description);
    const riskClass = inferRiskClass(description, inferred.capabilities);
    const name = options.name?.trim() || this.generateName(inferred.type, description);

    const config: AgentConfig = {
      name,
      description: description.trim(),
      agent_type: inferred.type,
      capabilities: inferred.capabilities,
      risk_class: riskClass,
      model: options.model || 'workstation-litellm/coding',
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 4096,
      system_prompt: '',
      tools: [],
      metadata: {
        created_from: 'nl-description',
        source_description: description,
        auto_generated: true,
      },
    };

    config.system_prompt = generateSystemPrompt(config);
    config.tools = this.suggestTools(inferred.type);

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO agents (
        id, name, description, status, capabilities, model, temperature, max_tokens,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      config.name,
      config.description,
      JSON.stringify(config.capabilities),
      config.model,
      config.temperature,
      config.max_tokens,
      JSON.stringify({ ...config.metadata, system_prompt: config.system_prompt, tools: config.tools }),
      now,
      now,
    );

    return {
      id,
      config,
      status: 'pending_approval',
      draft: true,
      created_at: now,
    };
  }

  /**
   * Approve a pending agent, making it available for loop assignment.
   */
  approveAgent(id: string): void {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    if (!agent) throw new Error('AGENT_NOT_FOUND');
    if (agent.status !== 'pending_approval') throw new Error('AGENT_NOT_PENDING');

    this.db.prepare("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  private generateName(type: string, description: string): string {
    const words = description.split(/\s+/).slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    const prefix = words.join('-').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20);
    const unique = randomUUID().slice(0, 6);
    return `${type}-${prefix}-${unique}`;
  }

  private suggestTools(agentType: string): string[] {
    const toolMap: Record<string, string[]> = {
      'security': ['sast-scan', 'dependency-audit', 'secret-scan', 'compliance-check'],
      'code-reviewer': ['code-review', 'diff-analysis', 'quality-gate', 'pr-comment'],
      'test-engineer': ['test-generate', 'test-run', 'coverage-report', 'mutation-test'],
      'deployer': ['deploy', 'rollback', 'health-check', 'release-note'],
      'researcher': ['web-search', 'summarize', 'analyze', 'cite'],
      'documenter': ['doc-generate', 'wiki-update', 'readme-sync', 'diagram-generate'],
      'monitor': ['health-check', 'alert-query', 'metric-collect', 'log-analysis'],
      'data-engineer': ['etl-run', 'data-validate', 'pipeline-manage', 'schema-check'],
      'infrastructure': ['server-provision', 'config-apply', 'health-check', 'backup-verify'],
      'orchestrator': ['task-delegate', 'status-query', 'schedule-manage', 'evidence-collect'],
      'generalist': ['task-execute', 'report-generate', 'status-query'],
    };
    return toolMap[agentType] || toolMap['generalist'];
  }
}
