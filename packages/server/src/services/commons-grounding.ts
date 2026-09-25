import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolve, sep } from 'path';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';

/**
 * G10: Agent Commons as a grounding guild. Prod 2026-09-24: 237 proposals waited in needs_grounding for a target file and a
 * test, while the Commons residents (kimi/glm) spent ~100 threads a day on self-chosen topics and ended every answer with
 * "I cannot verify current functionality" — they never saw code. Here a parked proposal becomes the topic, with candidate
 * files from a code search as evidence, and the answer's TARGET/TEST lines are checked in code.
 *   COMMONS_AGENDA_GROUNDING=true  → parked proposals become Commons topics (talk only)
 *   COMMONS_GROUNDING_APPLY=true   → a valid grounding becomes a grounded refinement for the specialist panel (operator decision)
 */
export const commonsGroundingAgendaEnabled = (): boolean => process.env.COMMONS_AGENDA_GROUNDING === 'true';
export const commonsGroundingApplyEnabled = (): boolean => process.env.COMMONS_GROUNDING_APPLY === 'true';

export function repoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOOP_DAEMON_REPOSITORY_PATH || env.LOOP_REPOSITORY_PATH || env.TEST_GAP_REPO_PATH || process.cwd();
}

const STOP = new Set(['about', 'after', 'agent', 'agents', 'before', 'being', 'change', 'could', 'djimitflo', 'every', 'evidence', 'first', 'improve', 'improvement', 'means', 'other', 'peer', 'proposal', 'should', 'system', 'their', 'there', 'these', 'thing', 'through', 'unverified', 'where', 'which', 'while', 'would']);
// Never ground into these: the same boundary as the evolve-loop design (no security/auth/deploy changes by the loop).
const SENSITIVE = /(^|\/)(auth|secrets?|deploy|\.env|\.github)(\/|\.|$)|middleware\/auth|spawn-token/i;

/** Distinctive words of a proposal: identifiers first (camelCase, kebab, snake), then long words. */
export function keywords(text: string, max = 6): string[] {
  const words = [...new Set((text.match(/[A-Za-z][A-Za-z0-9_-]{4,}/g) ?? []).map((w) => w.replace(/[-_]+$/, '')))]
    .filter((w) => !STOP.has(w.toLowerCase()));
  const score = (w: string) => (/[a-z][A-Z]|[-_]/.test(w) ? 100 : 0) + w.length;
  return words.sort((a, b) => score(b) - score(a)).slice(0, max);
}

/** Source files that match the most distinct keywords (git grep on tracked files; tests and sensitive paths excluded). */
export function candidateFiles(text: string, root: string, max = 5): string[] {
  const hits = new Map<string, number>();
  for (const kw of keywords(text)) {
    let out = '';
    try { out = execFileSync('git', ['-C', root, 'grep', '-l', '-i', '-F', '-e', kw, '--', ':(glob)packages/*/src/**'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }); } catch { continue; } // exit 1 = no match
    for (const f of out.split('\n').filter(Boolean)) if (!f.includes('__tests__') && !SENSITIVE.test(f)) hits.set(f, (hits.get(f) ?? 0) + 1);
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, max).map(([f]) => f);
}

/**
 * K3: OpenWiki pages (generated, sourced) that cite any of the files. Each page's front matter lists its sources as
 * `resource: repo://<path>`; a page that cites a candidate file is the fastest way for a resident to understand it.
 */
export function wikiPagesFor(files: string[], root: string, max = 3): string[] {
  const dir = resolve(root, 'openwiki');
  if (!files.length || !existsSync(dir)) return [];
  const want = new Set(files);
  const pages: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = resolve(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const head = readFileSync(full, 'utf8').split('\n---', 2)[0];
        if ([...head.matchAll(/resource:\s*repo:\/\/(\S+)/g)].some((m) => want.has(m[1]))) pages.push(full.slice(resolve(root).length + 1));
      }
    }
  };
  try { walk(dir); } catch { return []; }
  return pages.sort().slice(0, max);
}

export interface GroundingTopic { topic: string; topicRef: string; evidence: string[]; contexts: [string, string] }

/** Newest parked proposal not discussed yet that the code search can place; skips ones triage already called another system. */
export function pickGroundingTopic(db: Database, root = repoRoot()): GroundingTopic | null {
  const discussed = `('proposal:' || s.id) NOT IN (SELECT json_extract(payload_json, '$.params.topic_ref') FROM agent_messages
    WHERE json_extract(payload_json, '$.action') = 'social.question' AND json_type(payload_json, '$.params.topic_ref') = 'text')`;
  let rows: Array<{ id: string; title: string; description: string }>;
  try {
    rows = db.prepare(`SELECT s.id, s.title, s.description FROM self_improvements s
      WHERE s.status = 'needs_grounding' AND s.refined_at IS NULL AND ${discussed}
        AND NOT EXISTS (SELECT 1 FROM judgments j WHERE j.judgment = 'reflection_triage' AND j.subject_id = s.id
          AND (j.reason LIKE '%jev=other_system%' OR j.reason LIKE '%jev=aspiration%'))
      ORDER BY s.created_at DESC LIMIT 10`).all() as typeof rows;
  } catch { return null; } // agent_messages/judgments missing on minimal schemas
  for (const p of rows) {
    const files = candidateFiles(`${p.title} ${p.description}`, root);
    if (!files.length) continue;
    const topicRef = `proposal:${p.id}`;
    const wiki = wikiPagesFor(files, root);
    const ask = `Ground the parked Djimitflo proposal "${p.title.slice(0, 120)}": ${p.description.replace(/\s+/g, ' ').slice(0, 300)}. `
      + `A code search found these candidate files: ${files.join(', ')}. `
      + (wiki.length ? `The project wiki explains them in: ${wiki.join(', ')}. ` : '')
      + 'Pick the ONE file this change belongs in and ONE test that proves it works. '
      + 'The test may be an existing test file or a NEW file under packages/server/src/__tests__/ (for example packages/server/src/__tests__/<service>.test.ts). '
      + 'End every reply with two lines: "TARGET: <repo path>" and "TEST: <test file path>". If no file fits, write "TARGET: none".';
    return {
      topic: `Ground parked proposal: ${p.title.slice(0, 200)}`,
      topicRef,
      evidence: [topicRef, ...files.map((f) => `file:${f}`), ...wiki.map((w) => `wiki:${w}`)],
      contexts: [ask, `${ask} Challenge the peer's choice if a different candidate file fits better.`],
    };
  }
  return null;
}

/** The last TARGET:/TEST: lines of an answer. */
export function parseGrounding(text: string): { target?: string; test?: string } {
  // trailing punctuation is prose, not part of the path (prod 2026-09-25: "TARGET: none," was read as the file "none,")
  const last = (label: string) => [...text.matchAll(new RegExp(`${label}:\\s*\`?([^\\s\`"]+)`, 'gi'))].at(-1)?.[1]?.replace(/[.,;:)\]]+$/, '');
  return { target: last('TARGET'), test: last('TEST') };
}

const inside = (root: string, p: string) => { const base = resolve(root); const full = resolve(base, p); return full.startsWith(base + sep) ? full : null; };

/** Target must be an existing, non-sensitive source file; the test must exist or be a new test file under __tests__. */
export function validateGrounding(g: { target?: string; test?: string }, root: string): { valid: boolean; reason: string } {
  if (!g.target || g.target.toLowerCase() === 'none') return { valid: false, reason: 'no target' };
  const target = inside(root, g.target);
  if (!target || !existsSync(target) || !statSync(target).isFile()) return { valid: false, reason: `target not found: ${g.target}` };
  if (SENSITIVE.test(g.target)) return { valid: false, reason: `sensitive target: ${g.target}` };
  if (!g.test) return { valid: false, reason: 'no test' };
  const test = inside(root, g.test);
  if (!test) return { valid: false, reason: `test outside repo: ${g.test}` };
  if (!existsSync(test) && !/__tests__\/[^/]+\.test\.tsx?$/.test(g.test)) return { valid: false, reason: `test not found and not a new __tests__ file: ${g.test}` };
  return { valid: true, reason: `target=${g.target} test=${g.test}` };
}

/**
 * Records a Commons grounding as a `commons_grounding` judgment (checked in code, not by a model) and, when
 * COMMONS_GROUNDING_APPLY is set, turns a valid one into a grounded refinement that goes to the specialist panel.
 * Returns the refinement id when one was created.
 */
export function recordCommonsGrounding(db: Database, parkedId: string, messageId: string, text: string, root = repoRoot()): { valid: boolean; refinementId: string | null } {
  const g = parseGrounding(text);
  const { valid, reason } = validateGrounding(g, root);
  const apply = valid && commonsGroundingApplyEnabled();
  let refinementId: string | null = null;
  if (apply) {
    refinementId = new SelfImprovementService(db).groundFromCommons(parkedId, { target: g.target!, acceptanceTest: g.test! }, `commons-grounding:${messageId}`)?.id ?? null;
  }
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'commons_grounding', 'self_improvement', ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), parkedId, messageId, apply ? 'enforce' : 'shadow', valid ? 'yes' : 'no', reason, JSON.stringify({ ...g, message_id: messageId, refinement_id: refinementId }), new Date().toISOString());
  return { valid, refinementId };
}
