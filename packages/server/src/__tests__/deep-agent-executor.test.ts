import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, verify } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { DeepAgentExecutor } from '../execution/executors/deep-agent-executor';
import { canonicalJson, DeepAgentContractIssuer } from '../services/deep-agent-contract-issuer';

function task(taskId = 'task-1'): Task {
  return {
    id: taskId,
    title: 'Deep Agent canary',
    description: 'No-tool canary',
    status: 'pending',
    priority: 'low',
    risk_level: 'low',
    execution_mode: 'local',
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    created_by: null,
    owner_user_id: null,
    updated_by: null,
    tags: [],
    metadata: {
      deep_agent_contract: {
        identity: { task_id: taskId },
        capabilities: { profile_id: 'no-tool-canary' },
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const oldKey = process.env.DJIMIT_CANARY_SIGNING_KEY;
const oldOpenAiKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (oldKey === undefined) delete process.env.DJIMIT_CANARY_SIGNING_KEY;
  else process.env.DJIMIT_CANARY_SIGNING_KEY = oldKey;
  if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAiKey;
});

describe('DeepAgentExecutor', () => {
  it('accepts only a matching no-tool contract', () => {
    const executor = new DeepAgentExecutor('/runtime', '/python');
    expect(executor.canExecute(task())).toBe(true);
    expect(executor.canExecute(task('other'))).toBe(true);
    const mismatched = task();
    (mismatched.metadata.deep_agent_contract as any).identity.task_id = 'other';
    expect(executor.canExecute(mismatched)).toBe(false);
  });

  it('passes the contract on stdin and maps a successful child result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-deep-executor-'));
    const executable = path.join(root, 'fake-python');
    fs.writeFileSync(executable, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const contract = JSON.parse(input);
  process.stdout.write(JSON.stringify({ status: contract.identity.task_id === 'task-1' && !process.env.OPENAI_API_KEY ? 'COMPLETED' : 'FAILED' }) + '\\n');
});
`);
    fs.chmodSync(executable, 0o700);
    process.env.DJIMIT_CANARY_SIGNING_KEY = 'test-only';
    process.env.OPENAI_API_KEY = 'must-not-reach-child';

    const session = await new DeepAgentExecutor(root, executable).start(task());
    const events = [];
    for await (const event of session.events) events.push(event.event_type);
    const result = await session.result;

    expect(events).toEqual(['task.started', 'task.completed']);
    expect(result.status).toBe('completed');

    const rejectedSession = await new DeepAgentExecutor(root, executable).start(task('task-2'));
    const rejectedEvents = [];
    for await (const event of rejectedSession.events) rejectedEvents.push(event.event_type);
    expect(rejectedEvents).toEqual(['task.started', 'task.failed']);
    expect((await rejectedSession.result).status).toBe('failed');
    fs.rmSync(root, { recursive: true });
  });

  it('fails a runtime that exceeds its wall-clock timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-deep-timeout-'));
    const executable = path.join(root, 'fake-python');
    fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    process.env.DJIMIT_CANARY_SIGNING_KEY = 'test-only';

    const session = await new DeepAgentExecutor(root, executable).start(task(), { timeout: 25 });

    expect((await session.result).status).toBe('failed');
    fs.rmSync(root, { recursive: true });
  });

  it('force-stops a local runtime that ignores cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-deep-cancel-'));
    const executable = path.join(root, 'fake-python');
    fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    process.env.DJIMIT_CANARY_SIGNING_KEY = 'test-only';

    const session = await new DeepAgentExecutor(root, executable).start(task());
    await session.cancel();

    expect(session.status).toBe('cancelled');
    expect((await session.result).status).toBe('failed');
    fs.rmSync(root, { recursive: true });
  });

  it('posts the signed contract only to a loopback or Tailscale runtime', async () => {
    let redirect = false;
    const server = http.createServer((request, response) => {
      if (redirect) {
        response.writeHead(307, { location: 'https://example.com/collect' });
        response.end();
        return;
      }
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: JSON.parse(body).identity.task_id === 'task-1' ? 'COMPLETED' : 'FAILED' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');

    const session = await new DeepAgentExecutor('', '', `http://127.0.0.1:${address.port}`).start(task());
    expect((await session.result).status).toBe('completed');
    redirect = true;
    const redirected = await new DeepAgentExecutor('', '', `http://127.0.0.1:${address.port}`).start(task());
    expect((await redirected.result).status).toBe('failed');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    await expect(new DeepAgentExecutor('', '', 'https://example.com').start(task())).rejects.toThrow(
      'loopback or literal Tailscale IPv4',
    );
  });
});

describe('DeepAgentContractIssuer', () => {
  it('issues a verifiable contract only for an identified workload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-deep-issuer-'));
    const keyFile = path.join(root, 'federation.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const identified = task();
    identified.created_by = 'operator-1';
    identified.metadata.tenant_id = 'attacker-tenant';

    const contract = new DeepAgentContractIssuer(keyFile, 'test-key', 'server-tenant').issue(identified, 'dispatcher-1') as any;
    const unsigned = { ...contract };
    delete unsigned.signature;

    expect(contract.identity.issuer).toBe('djimitflo-federation');
    expect(contract.identity.audience).toBe('djimit-deep-runtime');
    expect(contract.identity.tenant_id).toBe('server-tenant');
    expect(contract.identity.actor_id).toBe('dispatcher-1');
    expect(contract.identity.workload_id).toBe('content-flywheel-canary');
    expect(contract.task.objective).toBe('Prove contract-gated no-tool execution');
    expect(contract.task.objective).not.toContain(identified.description);
    expect(verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(contract.signature.value, 'base64'))).toBe(true);
    expect(() => new DeepAgentContractIssuer(keyFile, 'test-key', 'server-tenant').issue(task(), '')).toThrow('authenticated actor identity');
    fs.rmSync(root, { recursive: true });
  });
});
