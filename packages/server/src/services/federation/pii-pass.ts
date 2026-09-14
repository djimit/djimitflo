/**
 * PII-pass voor externe federatie-payloads. Aanvulling op redactSecrets
 * (secret-only bij schrijven) — deze pass geldt op externe in/uit-paden.
 *
 * Modes: BLOCK (geen payload doorlaten bij PII), REDACT (vervang door label),
 * HASH (deterministisch pseudoniem), PASS (onveranderd teruggeven).
 * Fail-closed: onbekende mode wordt als REDACT behandeld.
 *
 * ponytail: detector-startset bewust beperkt (e-mail, telefoon, IBAN, BSN-achtig,
 * IP, naam-adres, geboortedatum). Plafond: geen volledige NER; upgrade is een
 * externe detector als false-negatives in praktijk pijn doen.
 */
import { createHash } from 'crypto';

export type PiiMode = 'BLOCK' | 'REDACT' | 'HASH' | 'PASS';
export type PiiKind = 'email' | 'phone' | 'iban' | 'bsn' | 'ip' | 'name-address' | 'birthdate';

interface Detector { kind: PiiKind; re: RegExp }

// Korte, lineaire patterns — geen nested quantifiers (regex-catastrofe vermeden).
const DETECTORS: Detector[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g },
  { kind: 'phone', re: /\+\d[\d\s-]{7,14}\d|\b0\d{1,2}[\s-]\d{6,8}\b|\b0\d{9}\b/g },
  { kind: 'ip', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g },
  { kind: 'birthdate', re: /\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b|\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g },
  { kind: 'name-address', re: /\b[A-Z][a-z]{2,}(?:van|de|der|den|van der|van den)?\s[A-Z][a-z]+,?\s+[A-Z][a-z]+(?:straat|laan|weg|plein|gracht)\s\d{1,5}[a-z]?\b/g },
];

// BSN-achtig: 9 cijfers; elfproef als secundaire check om false-positives te dempen.
const BSN_RE = /\b\d{9}\b/g;
function passesElfproef(candidate: string): boolean {
  const digits = candidate.split('').map(Number);
  const sum = digits.slice(0, 8).reduce((acc, d, i) => acc + d * (9 - i), 0) - digits[8];
  return sum % 11 === 0;
}

export function detectPii(value: string): PiiKind[] {
  const hits = new Set<PiiKind>();
  for (const { kind, re } of DETECTORS) {
    re.lastIndex = 0;
    if (re.test(value)) hits.add(kind);
  }
  BSN_RE.lastIndex = 0;
  for (const match of value.match(BSN_RE) ?? []) {
    if (passesElfproef(match)) { hits.add('bsn'); break; }
  }
  return [...hits];
}

function mask(mode: Exclude<PiiMode, 'PASS' | 'BLOCK'>, kind: PiiKind, raw: string): string {
  if (mode === 'REDACT') return `[${kind.toUpperCase()}]`;
  const digest = createHash('sha256').update(`${kind}:${raw}`).digest('hex').slice(0, 12);
  return `[${kind.toUpperCase()}:${digest}]`;
}

function scrub(value: string, mode: Exclude<PiiMode, 'PASS' | 'BLOCK'>): string {
  let out = value;
  for (const { kind, re } of DETECTORS) {
    re.lastIndex = 0;
    out = out.replace(re, (raw) => mask(mode, kind, raw));
  }
  BSN_RE.lastIndex = 0;
  out = out.replace(BSN_RE, (raw) => (passesElfproef(raw) ? mask(mode, 'bsn', raw) : raw));
  return out;
}

function walk(input: unknown, mode: Exclude<PiiMode, 'PASS' | 'BLOCK'>): unknown {
  if (typeof input === 'string') return scrub(input, mode);
  if (Array.isArray(input)) return input.map((v) => walk(v, mode));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = walk(v, mode);
    return out;
  }
  return input;
}

export interface PiiPassResult { ok: boolean; blocked: boolean; hits: PiiKind[]; payload: unknown }

/** Past de PII-pass toe op een externe payload (string of object van strings). */
export function applyPiiPass(payload: unknown, mode: PiiMode): PiiPassResult {
  const effective: PiiMode = mode === 'BLOCK' || mode === 'REDACT' || mode === 'HASH' || mode === 'PASS' ? mode : 'REDACT';
  const asText = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  const hits = detectPii(asText);
  if (hits.length === 0) return { ok: true, blocked: false, hits, payload };
  if (effective === 'PASS') return { ok: true, blocked: false, hits, payload };
  if (effective === 'BLOCK') return { ok: false, blocked: true, hits, payload: null };
  return { ok: true, blocked: false, hits, payload: walk(payload, effective) };
}
