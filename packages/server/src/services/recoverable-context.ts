import { createHash } from 'crypto';

/**
 * Recoverable compression for large tool outputs and log blocks (Challenger A, offline only).
 *
 * The verified mechanism this copies is the content-addressed recovery store: the original is put under its sha256 handle
 * BEFORE the shrunken text is returned, and a failed put or a compression that does not help passes the input through. The
 * gap it closes is the read side: expand() re-hashes the stored bytes, so a tampered or missing blob is an explicit error,
 * never a silent "byte-exact" answer.
 *
 * Rules are deterministic and line-based. Lines in a PRESERVED class (errors/failures/assertions, security findings,
 * prompt-injection shaped text, file:line source references) are kept verbatim; only repeated lines, long stack/progress
 * runs, dependency stack frames and the middle of oversized output are elided, each with a marker. JSON, JSONL and diffs
 * pass through untouched. Every output line is an input line, a marker, or an input line with an inline elision marker.
 *
 * Not wired into live makers. Wiring needs a paired experiment and operator OK (see the PR description).
 */

export interface BlobStore {
  put(handle: string, text: string): void;
  get(handle: string): string | undefined;
}

/** In-memory store, for tests and the offline replay. A live integration would inject a durable one. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, string>();
  put(handle: string, text: string): void { this.blobs.set(handle, text); }
  get(handle: string): string | undefined { return this.blobs.get(handle); }
}

export class RecoverableContextError extends Error {
  constructor(readonly code: 'invalid_handle' | 'missing' | 'tampered', message: string) {
    super(message);
    this.name = 'RecoverableContextError';
  }
}

export interface CompressOptions {
  /** inputs shorter than this pass through untouched (default 4 000 chars, about 1 k tokens) */
  minChars?: number;
  /** inputs longer than this pass through untouched (default 4 M chars): bounded CPU and store size */
  maxChars?: number;
  /** pass through unless the result is at least this much smaller (default 0.10) */
  minSavings?: number;
}

export interface CompressResult {
  text: string;
  /** null on pass-through; otherwise the store holds the original under it */
  handle: string | null;
}

const HANDLE_PREFIX = 'rc_sha256_';
const HANDLE_RE = /^rc_sha256_[0-9a-f]{64}$/;
const HEADER_PREFIX = '[recoverable-context ';

/** Line classes that are always kept verbatim. The compressor only matches text; it never evaluates or follows it. */
export const PRESERVED = {
  error: /error|fail|assert|expected|received|exception|panic|traceback|fatal|denied|not ok|✗|✕|×|\bERR!|\bE\d{3,}\b|TS\d{4}/i,
  security: /\b(CVE-\d{4}-\d+|CWE-\d+|GHSA-[\w-]+|vulnerab\w*|security|secrets?|credentials?|leak\w*|injection|xss|csrf|ssrf|rce|unsafe|malicious)\b/i,
  /** prompt-injection shaped text stays visible, so a downstream safety check or reviewer still sees it */
  injection: /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?)|disregard (all |any )?(previous|prior|above)|system prompt|you are now|new instructions|<\/?(system|assistant|user|tool|instructions?)>|\b(BEGIN|END) (SYSTEM|INSTRUCTIONS|PROMPT)\b|act as (an? )?|do not tell the user/i,
  /** path:line or path(line,col) source references */
  sourceRef: /\w\.[A-Za-z]{1,6}(:\d+|\(\d+,\d+\))/, // anchored on ".ext:line": linear time on very long lines
};
const STACK_LINE = /^\s*(at\s+\S|File ".*", line \d+|#\d+\s+0x[0-9a-f]+|\.\.\. \d+ more)/;
/** stack frames into dependencies or the runtime carry a source ref but are noise for a maker */
const DEPENDENCY_FRAME = /node_modules|node:internal|internal\/|<anonymous>|site-packages|\/usr\/lib\//;
const PROGRESS_LINE = /(\d{1,3}(\.\d+)?\s?%|\[[=#>.\- ]{4,}\]|^\s*[|/\\-]\s*$|\b(downloading|resolving|fetching|fetched|extracting|installing|added \d+ packages?|reify:|idealTree|timing)\b)/i;
const MAX_LINE = 1_000;
const RUN_KEEP_HEAD = 3;
const RUN_KEEP_TAIL = 1;
const RUN_MIN = 6;

export function isPreserved(line: string): boolean {
  if (PRESERVED.error.test(line) || PRESERVED.security.test(line) || PRESERVED.injection.test(line)) return true;
  return PRESERVED.sourceRef.test(line) && !(STACK_LINE.test(line) && DEPENDENCY_FRAME.test(line));
}

/** JSON, JSONL and unified diffs are consumed by parsers, so they are never rewritten. */
export function isStructured(text: string): boolean {
  const t = text.trim();
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return true; } catch { /* maybe JSONL */ } }
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length > 1 && lines.every((l) => { try { JSON.parse(l); return /^\s*[[{]/.test(l); } catch { return false; } })) return true;
  return /^diff --git /m.test(t) || (/^--- \S/m.test(t) && /^\+\+\+ \S/m.test(t) && /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(t));
}

export function handleFor(text: string): string {
  return HANDLE_PREFIX + createHash('sha256').update(text, 'utf8').digest('hex');
}

const marker = (what: string) => `[rc: ${what}]`;

interface Line { text: string; keep: boolean }

/** Step 1+2: collapse consecutive duplicate lines, then long stack/progress runs. Important lines are never removed. */
function collapse(lines: string[]): Line[] {
  // carriage-return progress bars redraw one line many times: show only the final redraw
  lines = lines.map((l) => {
    const cr = l.lastIndexOf('\r', l.length - 2);
    return cr < 0 || isPreserved(l) ? l : `${marker('carriage-return redraws elided')}${l.slice(cr + 1)}`;
  });
  const deduped: Line[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const important = isPreserved(lines[i]);
    deduped.push({ text: lines[i], keep: important });
    if (j - i > 1) deduped.push({ text: marker(`previous line repeated ${j - i - 1} more time(s)`), keep: important });
    i = j;
  }
  const out: Line[] = [];
  for (let i = 0; i < deduped.length;) {
    const kind = (l: Line) => (l.keep ? null : STACK_LINE.test(l.text) ? 'stack' : PROGRESS_LINE.test(l.text) ? 'progress' : null);
    const k = kind(deduped[i]);
    let j = i + 1;
    if (k) while (j < deduped.length && kind(deduped[j]) === k) j++;
    if (k && j - i >= RUN_MIN) {
      out.push(...deduped.slice(i, i + RUN_KEEP_HEAD));
      out.push({ text: marker(`${j - i - RUN_KEEP_HEAD - RUN_KEEP_TAIL} ${k} line(s) elided`), keep: false });
      out.push(...deduped.slice(j - RUN_KEEP_TAIL, j));
    } else {
      out.push(...deduped.slice(i, j));
    }
    i = j;
  }
  // very long non-important lines (minified JSON, base64): keep both ends
  return out.map((l) => (l.keep || l.text.length <= MAX_LINE ? l
    : { text: `${l.text.slice(0, MAX_LINE / 2)}${marker(`${l.text.length - MAX_LINE} chars elided`)}${l.text.slice(-MAX_LINE / 2)}`, keep: false }));
}

/** Step 3: over budget → keep head + tail + every important line; elide the rest in marked gaps. */
function fit(lines: Line[], budget: number): string[] {
  const size = (ls: Line[]) => ls.reduce((n, l) => n + l.text.length + 1, 0);
  if (size(lines) <= budget) return lines.map((l) => l.text);
  const keep = lines.map((l) => l.keep);
  let used = lines.reduce((n, l) => n + (l.keep ? l.text.length + 1 : 0), 0);
  // alternate head and tail (tail first: the end of a log carries the summary) until the budget is spent
  for (let head = 0, tail = lines.length - 1, fromTail = true; head <= tail; fromTail = !fromTail) {
    const i = fromTail ? tail-- : head++;
    if (keep[i]) continue;
    const cost = lines[i].text.length + 1;
    if (used + cost > budget) break;
    keep[i] = true;
    used += cost;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (keep[i]) { out.push(lines[i++].text); continue; }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    out.push(marker(`${j - i} line(s) elided`));
    i = j;
  }
  return out;
}

/**
 * Shrink `text` towards `budget` chars. The original is stored under its handle, and read back, before the result is
 * returned. Pass-through (handle null, text unchanged): input under minChars or over maxChars, JSON/JSONL/diff, already
 * compressed, savings under minSavings, any rule error, or a store that fails or does not return what it was given.
 * Preserved lines are kept even when that overshoots the budget.
 */
export function compress(text: string, budget: number, store: BlobStore, options: CompressOptions = {}): CompressResult {
  const minChars = options.minChars ?? 4_000;
  const maxChars = options.maxChars ?? 4_000_000;
  const minSavings = options.minSavings ?? 0.1;
  const passThrough = { text, handle: null };
  if (text.length < minChars || text.length > maxChars || text.startsWith(HEADER_PREFIX)) return passThrough;
  try {
    if (isStructured(text)) return passThrough;
    const handle = handleFor(text);
    const body = fit(collapse(text.split('\n')), Math.max(0, budget)).join('\n');
    const result = `${HEADER_PREFIX}${handle}: ${text.length} → ${body.length} chars; expand the handle for the original]\n${body}`;
    if (result.length > text.length * (1 - minSavings)) return passThrough;
    store.put(handle, text);
    if (store.get(handle) !== text) return passThrough;
    return { text: result, handle };
  } catch {
    return passThrough; // fail open: never return a shrunken text whose original is not stored
  }
}

/** The original bytes for `handle`. Throws RecoverableContextError when the handle is malformed, missing or tampered. */
export function expand(handle: string, store: BlobStore): string {
  if (!HANDLE_RE.test(handle)) throw new RecoverableContextError('invalid_handle', `not a recoverable-context handle: ${handle.slice(0, 80)}`);
  const blob = store.get(handle);
  if (blob === undefined) throw new RecoverableContextError('missing', `no stored original for ${handle}`);
  if (handleFor(blob) !== handle) throw new RecoverableContextError('tampered', `stored original for ${handle} does not match its sha256`);
  return blob;
}
