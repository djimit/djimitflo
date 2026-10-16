import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * EVO-K inheritance step (DREAM_PLAYBOOK_GENE=on|off, default off): the K4 skill cards of one lane (skill_cards, written by
 * skill-distillation.ts) become a deterministic playbook — ≤ 12 short lines from a FIXED template over card fields only
 * (target file pattern, diff shape, checks that passed; failure signature / error class / failed gate for 'Avoid:' lines).
 * No model call, no free text from any source: every interpolated value is reduced to a path/name charset. Same cards →
 * same lines → same sha256. Fewer than PLAYBOOK_MIN_CARDS usable cards → null (too little to inherit).
 * The dream (dream-evolution.ts) may attach the current playbook as ONE 'playbook' gene mutant; it is trialled and promoted
 * by the unchanged rules and reaches only GYM trial attempts through the ordinary genome lines.
 */
export const dreamPlaybookGene = (env: NodeJS.ProcessEnv = process.env): boolean => (env.DREAM_PLAYBOOK_GENE || '').trim().toLowerCase() === 'on';
export const PLAYBOOK_MIN_CARDS = 3;
export const PLAYBOOK_MAX_LINES = 12;
const MAX_SKILL_LINES = 8;
const MAX_AVOID_LINES = 4;

export interface PlaybookCite { source: 'skills' | 'anti_patterns'; id: string }
export interface Playbook { lane: string; lines: string[]; cites: PlaybookCite[][]; cards: number; sha256: string }

const parse = (s: string | null): Record<string, any> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
// card values are data, never text: path / identifier characters only, capped
const safe = (v: unknown, max = 60): string => String(v ?? '').replace(/[^A-Za-z0-9_./*@-]/g, '').slice(0, max);
const names = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((x) => safe(x)).filter(Boolean) : []).slice(0, n);
const int = (v: unknown): string => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : '?');

function skillLine(card: Record<string, any>): string | null {
  const patterns = names(card.target_pattern, 2);
  if (!patterns.length) return null;
  const d = card.diff_shape ?? {};
  const checks = names(card.checks_passed, 4);
  return `Proven shape: ${patterns.join(', ')} (${int(d.files_changed)} files, ${int(d.diff_lines)} diff lines${d.test_only === true ? ', test-only' : ''}); stayed green: ${checks.length ? checks.join(', ') : 'none recorded'}.`;
}
function avoidLine(card: Record<string, any>): string | null {
  const f = card.failure ?? {};
  const cls = safe(f.error_class, 40); const sig = safe(f.signature, 16); const gate = safe(f.gate, 40);
  if (!cls && !gate) return null;
  return `Avoid: the ${cls || 'unknown'} failure${sig ? ` (signature ${sig})` : ''} that stopped ${gate || 'an unknown step'} in this lane.`;
}

/**
 * The lane's playbook: survived skill cards first, then candidate ones (newest first, run_id as tie-break), then
 * anti-pattern cards; identical lines merge their citations. null when the lane has < 3 usable cards or no table.
 */
export function playbookFor(db: Database, lane: string): Playbook | null {
  type Row = { run_id: string; kind: 'skill' | 'anti_pattern'; card_json: string };
  let rows: Row[] = [];
  try {
    rows = db.prepare(`SELECT run_id, kind, card_json FROM skill_cards WHERE lane = ? AND status IN ('survived', 'candidate')
      ORDER BY CASE kind WHEN 'skill' THEN 0 ELSE 1 END, CASE status WHEN 'survived' THEN 0 ELSE 1 END, created_at DESC, run_id`).all(lane) as Row[];
  } catch { return null; }
  const lines: string[] = []; const cites: PlaybookCite[][] = []; let cards = 0; let skills = 0; let avoids = 0;
  for (const r of rows) {
    const isSkill = r.kind === 'skill';
    const line = isSkill ? skillLine(parse(r.card_json)) : avoidLine(parse(r.card_json));
    if (!line) continue;
    const i = lines.indexOf(line);
    if (i >= 0) { cites[i].push({ source: isSkill ? 'skills' : 'anti_patterns', id: r.run_id }); cards++; continue; }
    if (lines.length >= PLAYBOOK_MAX_LINES || (isSkill ? skills >= MAX_SKILL_LINES : avoids >= MAX_AVOID_LINES)) continue;
    lines.push(line); cites.push([{ source: isSkill ? 'skills' : 'anti_patterns', id: r.run_id }]); cards++;
    if (isSkill) skills++; else avoids++;
  }
  if (cards < PLAYBOOK_MIN_CARDS) return null;
  return { lane, lines, cites, cards, sha256: createHash('sha256').update(JSON.stringify({ lane, lines })).digest('hex') };
}

/** Lanes to try, in order: the given (failing) lanes, then lanes by usable card count (desc), then name. */
export function playbookLanes(db: Database, preferred: string[]): string[] {
  let byCount: string[] = [];
  try {
    byCount = (db.prepare(`SELECT lane FROM skill_cards WHERE lane IS NOT NULL AND status IN ('survived', 'candidate') GROUP BY lane ORDER BY COUNT(*) DESC, lane`).all() as Array<{ lane: string }>).map((r) => r.lane);
  } catch { /* no table: nothing */ }
  return [...new Set([...preferred, ...byCount])];
}

/** The note on a playbook genome: lane and content hash (dedupe key — the same playbook is never trialled twice). */
export const playbookNote = (p: Playbook): string => `lane playbook ${safe(p.lane, 80)} sha256 ${p.sha256}`;

/**
 * Evidence (genomes.playbook): playbook genes proposed / promoted / retired / inconclusive / pending, from maker_genomes
 * (gene 'playbook'). proposed null = none proposed yet (unknown, never 0).
 */
export function playbookGeneEvidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const enabled = dreamPlaybookGene(env);
  const note = 'trial genomes only (GYM trial attempts); selection unchanged. One deterministic playbook mutant per dream at most (DREAM_PLAYBOOK_GENE)';
  let rows: Array<{ status: string; n: number }> = [];
  try { rows = db.prepare("SELECT status, COUNT(*) AS n FROM maker_genomes WHERE gene = 'playbook' GROUP BY status").all() as typeof rows; } catch { /* unknown */ }
  if (!rows.length) return { enabled, proposed: null, promoted: null, retired: null, inconclusive: null, pending: null, note };
  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { enabled, proposed: rows.reduce((a, r) => a + r.n, 0), promoted: n('active'), retired: n('retired'), inconclusive: n('inconclusive'), pending: n('trial'), note };
}
