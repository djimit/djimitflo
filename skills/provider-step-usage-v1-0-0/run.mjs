import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export const MAX_BYTES = 262144;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(`USAGE_${code}`); };

/** OpenCode step_finish part totals are per-step measurements, not cumulative totals. */
export function summarize(input) {
  if (!object(input) || Object.keys(input).length !== 1 || typeof input.events_json !== 'string') fail('INPUT');
  if (Buffer.byteLength(input.events_json, 'utf8') > MAX_BYTES) fail('SIZE');
  const seen = new Map();
  let tokens = 0;
  for (const line of input.events_json.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { fail('JSON'); }
    if (!object(event) || typeof event.type !== 'string') fail('EVENT');
    if (event.type !== 'step_finish') continue;
    const part = event.part;
    if (!object(part) || typeof part.id !== 'string' || !part.id.trim() || part.id.length > 256) fail('IDENTITY');
    const total = part.tokens?.total;
    if (!Number.isSafeInteger(total) || total < 0) fail('TOTAL');
    // Identity is the provider part ID. Distinct metadata under one ID is ambiguous.
    const scope = [part.sessionID, part.messageID, event.sessionID];
    if (scope.some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 256))) fail('IDENTITY');
    const fingerprint = JSON.stringify([total, ...scope]);
    if (seen.has(part.id)) {
      if (seen.get(part.id) !== fingerprint) fail('CONFLICT');
      continue;
    }
    seen.set(part.id, fingerprint);
    tokens += total;
    if (!Number.isSafeInteger(tokens)) fail('OVERFLOW');
  }
  if (!seen.size) fail('NO_MEASUREMENTS');
  return { tokens, steps: seen.size };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) fail('SIZE');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON'); }
  process.stdout.write(`${JSON.stringify(summarize(input))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch(error => {
    // Never echo provider payloads: they may contain credentials or private task data.
    process.stderr.write(`${/^USAGE_[A-Z_]+$/.test(error.message) ? error.message : 'USAGE_FAILURE'}\n`);
    process.exitCode = 1;
  });
}
