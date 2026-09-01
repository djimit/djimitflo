#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'openspec/changes/assurance-truth-closure/integration-evidence.json');

async function http(id, url, required, validate) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    return { id, kind: 'http', required, target: url, status: required ? 'blocked' : 'unavailable', latency_ms: Date.now() - started, reason: error instanceof Error ? error.message : String(error) };
  }
  let contractValid = true;
  try {
    if (response.ok && validate) contractValid = await validate(response);
  } catch {
    contractValid = false;
  }
  return {
    id, kind: validate ? 'http-contract' : 'http', required, target: url,
    status: response.ok && contractValid ? 'pass' : 'fail', http_status: response.status,
    latency_ms: Date.now() - started,
    reason: response.ok && !contractValid ? 'response contract mismatch' : undefined,
  };
}

async function eventStream(url) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    return { id: 'event_bus', kind: 'http-json', required: true, target: url, status: 'blocked', latency_ms: Date.now() - started, reason: error instanceof Error ? error.message : String(error) };
  }
  let body;
  try {
    body = response.ok ? await response.json() : null;
  } catch {
    return { id: 'event_bus', kind: 'http-json', required: true, target: url, status: 'fail', http_status: response.status, latency_ms: Date.now() - started, reason: 'response is not valid JSON' };
  }
  return {
    id: 'event_bus', kind: 'http-json', required: true, target: url,
    status: response.ok && Array.isArray(body?.events) ? 'pass' : 'fail',
    http_status: response.status, latency_ms: Date.now() - started,
    reason: response.ok && !Array.isArray(body?.events) ? 'response.events is not an array' : undefined,
  };
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

const eventBusUrl = process.env.DJIMIT_EVENT_BUS_URL || 'http://100.86.47.122:8083';
const eventStreamUrl = `${eventBusUrl.replace(/\/$/, '')}/events/${encodeURIComponent(process.env.DJIMIT_EVENT_STREAM || 'djimit.events')}?count=1`;
const probes = await Promise.all([
  http('djimitflo', `${process.env.DJIMITFLO_LIVE_URL || 'http://100.86.47.122:3001'}/health`, true, async response => (await response.json()).status === 'healthy'),
  eventStream(eventStreamUrl),
  http('paperclip', `${process.env.PAPERCLIP_URL || 'http://192.168.1.28:3100'}/api/health`, true, async response => { const body = await response.json(); return body.status === 'ok' && typeof body.commit === 'string'; }),
  http('uams', `${process.env.UAMS_URL || 'http://100.77.58.72:8000'}/health`, true, async response => (await response.json()).status === 'healthy'),
  http('ollama', `${process.env.OLLAMA_URL || 'http://100.77.58.72:11434'}/api/tags`, true, async response => Array.isArray((await response.json()).models)),
  http('qdrant', `${process.env.QDRANT_URL || 'http://100.77.58.72:6333'}/healthz`, true, async response => (await response.text()).trim() === 'healthz check passed'),
  http('litellm', `${process.env.LITELLM_URL || 'http://192.168.1.28:4000'}/health`, false),
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
