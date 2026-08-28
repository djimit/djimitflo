import { createPrivateKey, randomUUID, sign, type KeyObject } from 'crypto';
import fs from 'fs';
import type { Task } from '@djimitflo/shared';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Contract contains an unsupported value');
  return encoded;
}

export class DeepAgentContractIssuer {
  private readonly privateKey: KeyObject;

  constructor(
    privateKeyFile = process.env.DJIMIT_DEEP_FEDERATION_PRIVATE_KEY_FILE ?? '',
    private readonly keyId = process.env.DJIMIT_DEEP_FEDERATION_KEY_ID ?? 'federation-1',
  ) {
    if (!privateKeyFile) throw new Error('DJIMIT_DEEP_FEDERATION_PRIVATE_KEY_FILE is required');
    const stat = fs.statSync(privateKeyFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Federation private key must be a regular file with mode 0600 or stricter');
    this.privateKey = createPrivateKey(fs.readFileSync(privateKeyFile));
  }

  issue(task: Task): Record<string, unknown> {
    const metadata = task.metadata as Record<string, unknown>;
    const tenantId = metadata.tenant_id;
    const actorId = task.owner_user_id ?? task.created_by;
    const workloadId = metadata.workload_id;
    if (typeof tenantId !== 'string' || !tenantId || typeof actorId !== 'string' || !actorId || typeof workloadId !== 'string' || !workloadId) {
      throw new Error('Deep Agent dispatch requires tenant_id, actor identity and workload_id');
    }
    const now = new Date();
    const contract: Record<string, any> = {
      contract_version: '1.0',
      identity: {
        task_id: task.id,
        execution_id: randomUUID(),
        parent_execution_id: null,
        delegation_id: null,
        tenant_id: tenantId,
        actor_id: actorId,
        workload_id: workloadId,
        issuer: 'djimitflo-federation',
        audience: 'djimit-deep-runtime',
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
        nonce: randomUUID(),
      },
      task: {
        objective: task.description,
        use_case: 'foundation-canary',
        risk_class: String(task.risk_level).toUpperCase(),
        input_refs: [],
        expected_outputs: ['evidence events'],
        acceptance_criteria: ['no model or tool call'],
        forbidden_outcomes: ['network access outside operational event sink'],
      },
      capabilities: {
        profile_id: 'no-tool-canary',
        allowed_tools: [], allowed_mcp_servers: [], allowed_models: [], allowed_paths: [], allowed_network_destinations: [],
        max_subagent_depth: 0, max_parallel_subagents: 0, max_total_subagents: 0,
      },
      budget: { max_model_calls: 0, max_tool_calls: 0, max_tokens: 0, max_cost: 0, max_wall_clock_seconds: 5 },
      data: { classification: 'PUBLIC', pii_allowed: false, external_provider_allowed: false, retention_policy: 'canary-7d' },
      approval: { policy_id: 'no-consequential-actions', required_for: [] },
      fallback: { silent_fallback: false, approved_routes: [], fail_closed: true },
      evidence: {
        required_events: ['EXECUTION_CREATED', 'EXECUTION_COMPLETED', 'EVIDENCE_READY'],
        required_artifacts: [], required_tests: ['contract-validation'], eve_v_required: true,
      },
      signature: { algorithm: 'Ed25519', key_id: this.keyId, value: '' },
    };
    const unsigned = { ...contract };
    delete unsigned.signature;
    contract.signature.value = sign(null, Buffer.from(canonicalJson(unsigned)), this.privateKey).toString('base64');
    return contract;
  }
}
