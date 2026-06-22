import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile, Evaluation } from './db';

function loadSchema(): any {
  const candidates = [
    join(__dirname, 'schema/djimit-agent-profile.schema.json'),
    join(__dirname, '../src/schema/djimit-agent-profile.schema.json'),
  ];
  for (const p of candidates) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* try next */ } }
  throw new Error('djimit-agent-profile.schema.json not found');
}
const schema = loadSchema();

const TYPEOF: Record<string, string> = { string: 'string', integer: 'number', number: 'number', array: 'Array', object: 'Object', boolean: 'boolean' };
function typeOf(v: any): string {
  if (Array.isArray(v)) return 'Array';
  if (v === null) return 'null';
  return typeof v === 'object' ? 'Object' : typeof v === 'number' ? 'number' : 'string';
}

export function validateSchema(profile: Profile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const req of schema.required as string[]) {
    if (profile[req as keyof Profile] === undefined || profile[req as keyof Profile] === null || profile[req as keyof Profile] === '') errors.push(`missing required: ${req}`);
  }
  for (const [k, def] of Object.entries<any>(schema.properties)) {
    const v = (profile as any)[k];
    if (v === undefined) continue;
    const want = TYPEOF[def.type];
    if (want && typeOf(v) !== want) errors.push(`${k}: expected ${def.type}, got ${typeOf(v)}`);
  }
  return { valid: errors.length === 0, errors };
}

const INJECTION_PATTERNS = [
  { re: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|rules|prompts)/i, w: 3, flag: 'instruction-override' },
  { re: /disregard\s+(all|any|the)\s+(previous|prior|above)\s+(instructions|rules)/i, w: 3, flag: 'instruction-override' },
  { re: /\bDAN\b|do anything now/i, w: 3, flag: 'jailbreak' },
  { re: /you are now (a |an )?(jailbreak|unrestricted|root|admin)/i, w: 3, flag: 'jailbreak' },
  { re: /act as[^.\n]{0,80} without (restrictions|limits|rules)/i, w: 3, flag: 'jailbreak' },
  { re: /\b(reveal|expose|show|print)\s+(your|the|this)\s+(system\s+)?prompt\b/i, w: 3, flag: 'prompt-exfil' },
  { re: /exfiltrat(e|ion)/i, w: 3, flag: 'exfiltration' },
  { re: /send\s+(data|secrets?|credentials?|tokens?|keys?|passwords?)\s+to\b/i, w: 3, flag: 'exfiltration' },
  { re: /base64[- ]?decode|eval\s*\(\s*atob/i, w: 2, flag: 'obfuscation' },
  { re: /\brm\s+-rf\s+\/|rm\s+-rf\s+~/i, w: 3, flag: 'destructive-shell' },
  { re: /curl\s+[^|\n]{0,120}\|\s*(sh|bash)|wget\s+[^|\n]{0,120}\|\s*(sh|bash)/i, w: 3, flag: 'remote-code-exec' },
  { re: /chmod\s+-R\s+777|chmod\s+777/i, w: 2, flag: 'unsafe-permission' },
  { re: /disable (safety|guardrails|content policy|alignment)/i, w: 3, flag: 'safety-disable' },
  { re: /do not follow (your|the) (rules|instructions|policy)/i, w: 2, flag: 'rule-bypass' },
  { re: /\b(kill|killall|pkill)\b[^.\n]{0,40}-9/i, w: 1, flag: 'aggressive-kill' },
];

export function scanInjection(text: string): { score: number; flags: string[]; level: string } {
  const hay = text || ''; let score = 0; const flags = new Set<string>();
  for (const p of INJECTION_PATTERNS) if (p.re.test(hay)) { score += p.w; flags.add(p.flag); }
  let level = 'low';
  if (score >= 6) level = 'critical'; else if (score >= 3) level = 'high'; else if (score >= 1) level = 'medium';
  return { score, flags: [...flags], level };
}

function profileText(p: Profile): string {
  return [p.name, p.mission, p.persona, ...(p.rules || []), ...(p.deliverables || [])].join(' ');
}
function shingles(text: string, k = 3): Set<string> {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
export function overlapScore(a: Profile, b: Profile): number { return jaccard(shingles(profileText(a)), shingles(profileText(b))); }

export function runStaticGate(profile: Profile, existing: Profile[] = []): Evaluation {
  const schemaRes = validateSchema(profile);
  const inj = scanInjection(profileText(profile) + ' ' + (profile.description || ''));
  let maxOverlap = 0; let overlapWith: string | null = null; const overlaps: { id: string; score: number }[] = [];
  for (const other of existing) {
    if (other.id === profile.id) continue;
    const s = overlapScore(profile, other);
    if (s > 0.5) overlaps.push({ id: other.id, score: s });
    if (s > maxOverlap) { maxOverlap = s; overlapWith = other.id; }
  }
  const passed = schemaRes.valid && inj.score === 0 && maxOverlap < 0.85;
  const riskLevel = inj.level === 'low' ? (maxOverlap >= 0.6 ? 'medium' : 'low') : inj.level;
  return {
    profile_id: profile.id, schema_valid: schemaRes.valid, schema_errors: schemaRes.errors,
    injection_score: inj.score, injection_flags: inj.flags,
    overlap_score: Math.round(maxOverlap * 1000) / 1000, overlap_with: overlapWith, overlaps,
    risk_level: riskLevel,
    flags: [...inj.flags, ...(maxOverlap >= 0.85 ? ['near-duplicate'] : []), ...(!schemaRes.valid ? ['schema-invalid'] : [])],
    status: passed ? 'passed' : 'rejected',
  };
}
