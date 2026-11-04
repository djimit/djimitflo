#!/usr/bin/env node
/**
 * Warn-only docs check: every ```mermaid block in the given Markdown files (default: .md files under openwiki/ and docs/
 * changed vs the merge base with --base, default origin/main) is validated by the hosted Mermaid API
 * (POST https://api.mermaid.ai/v1/validate — beta, 1 credit per call, 500 credits/month). Prints file:line + the parser
 * error for a block the API says is invalid.
 *   node scripts/mermaid-validate.mjs [--base <ref>] [file.md ...]
 * Exit 0: MERMAID_API_KEY absent ("skipped: no key"), API unavailable (401/402/429/5xx/timeout/network → warning), or all
 * valid. Exit 1 only on a definite `valid: false`. At most MAX_CALLS calls per run; identical blocks are sent once.
 * The key comes from the environment only and is never printed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VALIDATE_URL = 'https://api.mermaid.ai/v1/validate';
export const MAX_CALLS = 40;
const TIMEOUT_MS = 5_000;

/** ```mermaid / ~~~mermaid fenced blocks → { line (1-based line of the first code line), code }. */
export function extractMermaidBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*mermaid\b/.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].trim().startsWith(fence); j++) body.push(lines[j]);
    if (body.join('').trim()) out.push({ line: i + 2, code: body.join('\n') });
    i = j;
  }
  return out;
}

/** One POST /v1/validate: { status: valid | invalid | unavailable, code, message?, line?, column? }. */
export async function validateBlock(code, apiKey, fetchFn = fetch, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetchFn(VALIDATE_URL, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { status: 'unavailable', code: `http_${res.status}${typeof body?.error?.code === 'string' ? `:${body.error.code}` : ''}` };
    if (body?.valid === true) return { status: 'valid', code: null };
    if (body?.valid !== false) return { status: 'unavailable', code: 'unparsed' };
    const d = body.error?.details ?? {};
    return { status: 'invalid', code: body.error?.code ?? 'ERR_DIAGRAM_INVALID', message: String(body.error?.message ?? '').split('\n')[0].slice(0, 200),
      line: typeof d.line === 'number' ? d.line : undefined, column: typeof d.column === 'number' ? d.column : undefined };
  } catch (err) {
    return { status: 'unavailable', code: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

/** .md files under openwiki/ or docs/ (any depth: a git pathspec `*` matches `/`) added/modified since the merge base with `base`. */
export function changedDocs(base = 'origin/main') {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', 'openwiki/*.md', 'docs/*.md'], { encoding: 'utf8' });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** Returns the exit code. `log` gets stdout lines, `warn` stderr lines. */
export async function run({ files, env = process.env, fetchFn = fetch, log = console.log, warn = console.warn, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS } = {}) {
  const key = env.MERMAID_API_KEY?.trim();
  if (!key) { log('mermaid-validate: skipped: no key (MERMAID_API_KEY unset)'); return 0; }
  const blocks = files.flatMap((file) => (fs.existsSync(file) ? extractMermaidBlocks(fs.readFileSync(file, 'utf8')).map((b) => ({ file, ...b })) : []));
  if (!blocks.length) { log(`mermaid-validate: no mermaid blocks in ${files.length} file(s)`); return 0; }
  const seen = new Map(); // sha256 → verdict, so an identical block costs one credit
  let calls = 0; let invalid = 0; let unavailable = 0; let skipped = 0;
  for (const b of blocks) {
    const sha = createHash('sha256').update(b.code).digest('hex');
    let v = seen.get(sha);
    if (!v) {
      if (calls >= maxCalls) { skipped++; continue; }
      calls++;
      v = await validateBlock(b.code, key, fetchFn, timeoutMs);
      seen.set(sha, v);
      if (v.status === 'unavailable' && /^http_(401|402|429)/.test(v.code)) { warn(`mermaid-validate: warning: API unavailable (${v.code}); stopping`); unavailable++; break; }
    }
    if (v.status === 'invalid') {
      invalid++;
      const at = b.line + (v.line ? v.line - 1 : 0);
      log(`${b.file}:${at}${v.column ? `:${v.column}` : ''}: ${v.code}${v.message ? ` ${v.message}` : ''}`);
    } else if (v.status === 'unavailable') {
      unavailable++;
      warn(`mermaid-validate: warning: ${b.file}:${b.line}: API unavailable (${v.code}), not checked`);
    }
  }
  if (skipped) warn(`mermaid-validate: warning: call cap ${maxCalls} reached, ${skipped} block(s) not checked`);
  log(`mermaid-validate: ${blocks.length} block(s), ${calls} call(s), ${invalid} invalid, ${unavailable} unavailable`);
  return invalid ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--base');
  const base = bi >= 0 ? args.splice(bi, 2)[1] : 'origin/main';
  let files = args;
  if (!files.length) {
    try { files = changedDocs(base); } catch (err) { console.warn(`mermaid-validate: warning: cannot diff against ${base} (${err.message.split('\n')[0]}); nothing checked`); process.exit(0); }
  }
  process.exit(await run({ files }));
}
