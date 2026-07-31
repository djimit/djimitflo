#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'openspec/changes/assurance-truth-closure/integration-evidence.json');

async function http(id, url, required) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { id, kind: 'http', required, target: url, status: response.ok ? 'pass' : 'fail', http_status: response.status, latency_ms: Date.now() - started };
  } catch (error) {
    return { id, kind: 'http', required, target: url, status: required ? 'blocked' : 'unavailable', latency_ms: Date.now() - started, reason: error instanceof Error ? error.message : String(error) };
  }
}

function binary(id, command, required) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return {
    id, kind: 'binary', required, target: command,
    status: result.status === 0 ? 'pass' : required ? 'blocked' : 'unavailable',
    version: result.status === 0 ? String(result.stdout || result.stderr).trim().slice(0, 300) : undefined,
    reason: result.status === 0 ? undefined : result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`,
  };
}

const probes = await Promise.all([
  http('ollama', `${process.env.OLLAMA_URL || 'http://192.168.1.28:11434'}/api/tags`, true),
  http('litellm', `${process.env.LITELLM_URL || 'http://192.168.1.28:4000'}/health`, true),
  http('qdrant', `${process.env.QDRANT_URL || 'http://192.168.1.28:6333'}/healthz`, true),
  http('context7', process.env.CONTEXT7_URL || 'https://mcp.context7.com/mcp', false),
  Promise.resolve(binary('codex', process.env.CODEX_COMMAND || 'codex', true)),
  Promise.resolve(binary('opencode', process.env.OPENCODE_COMMAND || 'opencode', false)),
]);
const status = probes.some(probe => probe.required && probe.status === 'fail') ? 'fail'
  : probes.some(probe => probe.required && probe.status === 'blocked') ? 'blocked' : 'pass';
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  status,
  probes,
  next_safe_action: status === 'pass' ? 'Verify deployed Djimitflo identity.' : 'Restore required workstation services, then rerun read-only probes.',
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${status.toUpperCase()} ${output}`);
process.exitCode = status === 'pass' ? 0 : status === 'blocked' ? 2 : 1;
