/**
 * U4c (re-20261029 E-assumptions A5 / C1, LB4 "shadow means measures, never decides" — FALSIFIED): a static registry of
 * every place where a judgment's mode (judgmentMode(...)), a verdict/record mode check (x.mode === 'shadow'|'enforce') or a
 * shadow-mode check verdict (assertionStrengthVerdict) guards control flow. Behaviour is not changed here: the registry
 * makes each coupling explicit. A new, unlisted site fails this test until it is classified below; a removed site fails
 * until its entry is removed. `gate_read` = a verdict recorded under a 'shadow' label decides something (the operator must
 * know these exist before a shadow → enforce promotion); its anchor pins the deciding line.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GATE_READ_JUDGMENTS } from '../services/value-allocator';

const SRC = path.resolve(__dirname, '..');
const PATTERNS = {
  judgmentMode: /\bjudgmentMode\(/g,
  assertionStrengthVerdict: /\bassertionStrengthVerdict\(/g,
  modeCheck: /\.mode\s*[!=]==\s*'(?:shadow|enforce)'/g,
} as const;
type Pattern = keyof typeof PATTERNS;
/** gate_read: a shadow-labelled verdict decides; enforce_only: acts only on an enforce verdict under enforce; measurement:
 *  the mode only switches the judgment itself on/off; infrastructure: the judgment runner / its own accounting;
 *  not_a_judgment: the `.mode` of another component (not a judgment verdict). */
type Kind = 'gate_read' | 'enforce_only' | 'measurement' | 'infrastructure' | 'not_a_judgment';
interface Entry { file: string; pattern: Pattern; count: number; kind: Kind; why: string; anchors?: string[]; judgment?: string }

const GATE_READS: Entry[] = [
  // ── gate_read: a 'shadow' label that decides (known 2026-10-29; all restrict, none widens — except requeue eligibility) ──
  { file: 'services/expert-source-units-service.ts', pattern: 'judgmentMode', count: 7, kind: 'gate_read', judgment: 'discovery_relevance',
    why: "FRONTIER_UNITS_REQUIRE_RELEVANCE=true: the discovery_relevance verdict (TYPESAFE_DISCOVERY_RELEVANCE_MODE=shadow in prod) decides unit creation and overrides the keyword gate; the rest park/skip/retry the same judgment",
    anchors: ["process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true' && judgmentMode(discoveryRelevance.id) !== 'off'",
      "process.env.FRONTIER_UNITS_REQUIRE_RELEVANCE === 'true' && !this.knownRefs().has(ref)) this.overrideUnit(d, verdict.id)"] },
  { file: 'services/loop-auto-merge.ts', pattern: 'assertionStrengthVerdict', count: 1, kind: 'gate_read',
    why: 'earned auto-merge merges only on an assertion-strength pass; the check runs with WEAK_ASSERTION_CHECK_MODE=shadow in prod (verdict in shadow_status)',
    anchors: ["if (strength !== 'pass') { record('ineligible', `assertion_strength_${strength ?? 'missing'}`); continue; }"] },
  { file: 'services/improvement-requeue.ts', pattern: 'assertionStrengthVerdict', count: 1, kind: 'gate_read',
    why: 'a verified test-gap/mutation-gap proposal whose maker recorded no (shadow) assertion-strength check becomes requeue-eligible',
    anchors: ['return assertionStrengthVerdict(checks) === null;'] },
  { file: 'services/agent-social-autopilot-service.ts', pattern: 'judgmentMode', count: 3, kind: 'gate_read', judgment: 'commons_contribution',
    why: 'threadGated: with COMMONS_THREAD_GATE_ENABLED the last two (shadow) commons_contribution verdicts gate a thread (inert while the judgment is off); the other two only switch the judgments on',
    anchors: ["if (env.COMMONS_THREAD_GATE_ENABLED !== 'true' || judgmentMode(commonsContribution.id, env) === 'off') return false;"] },
  // ── enforce_only: a verdict acts only when both the judgment and the record are 'enforce' ──
  { file: 'services/self-improvement-auto-review-scheduler.ts', pattern: 'judgmentMode', count: 2, kind: 'enforce_only', why: 'proposal_prescreen parks only under enforce with an enforce-labelled verdict' },
  { file: 'services/self-improvement-auto-review-scheduler.ts', pattern: 'modeCheck', count: 1, kind: 'enforce_only', why: "prescreen?.mode === 'enforce'" },
  { file: 'services/decision-context-service.ts', pattern: 'judgmentMode', count: 1, kind: 'enforce_only', why: "decision_context injects memories only when mode === 'enforce' (shadow records the selection)" },
  { file: 'services/kb-corpus.ts', pattern: 'modeCheck', count: 1, kind: 'enforce_only', why: 'kb_passage_relevance drops passages only on an enforce record' },
  { file: 'services/memory-template-dedup.ts', pattern: 'modeCheck', count: 1, kind: 'enforce_only', why: "template dedup skips only under enforce ('would_skip' otherwise)" },
  // ── measurement: the mode only switches the judgment (a measurement) on or off ──
  { file: 'services/local-shadow-queue.ts', pattern: 'judgmentMode', count: 2, kind: 'measurement', why: 'local shadow jobs are skipped when their judgment is off' },
  { file: 'services/self-improvement-service.ts', pattern: 'judgmentMode', count: 1, kind: 'measurement', why: 'reflection_triage fire-and-forget (its consumer, needs-grounding triage, reads rows, see value-allocator GATE_READ_JUDGMENTS)' },
  { file: 'services/loop-worker-executor-service.ts', pattern: 'judgmentMode', count: 1, kind: 'measurement', why: 'checker second opinion recorded, never a verdict' },
  { file: 'services/dream-state-service.ts', pattern: 'judgmentMode', count: 1, kind: 'measurement', why: 'failure_cause replay classifies, decides nothing' },
  { file: 'services/autonomy-shadow-service.ts', pattern: 'judgmentMode', count: 1, kind: 'measurement', why: 'risk_atomic answers next to the keyword class (shadow, fire-and-forget)' },
  // ── infrastructure ──
  { file: 'services/judgment-service.ts', pattern: 'judgmentMode', count: 5, kind: 'infrastructure', why: 'the runner: resolves and records the mode label' },
  { file: 'services/value-allocator.ts', pattern: 'judgmentMode', count: 1, kind: 'infrastructure', why: 'GATE_READ_JUDGMENTS accounting of the rows a gate reads' },
  { file: 'services/value-allocator.ts', pattern: 'modeCheck', count: 6, kind: 'infrastructure', why: 'GATE_READ_JUDGMENTS: which enforce rows a gate consumed; shadow-row counting' },
  { file: 'services/test-assertion-strength.ts', pattern: 'assertionStrengthVerdict', count: 1, kind: 'infrastructure', why: 'the definition' },
  // ── not_a_judgment: another component's mode ──
  { file: 'services/loop-service.ts', pattern: 'modeCheck', count: 1, kind: 'not_a_judgment', why: "display of a deterministic check's shadow status" },
  { file: 'services/inference-budget.ts', pattern: 'modeCheck', count: 1, kind: 'not_a_judgment', why: 'inference budget would_pause (its own shadow flag)' },
  { file: 'services/asg/oracle-lane.ts', pattern: 'modeCheck', count: 1, kind: 'not_a_judgment', why: 'oracle lane shadow verification stop' },
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // comments are not control flow

const found = new Map<string, number>(); // `${file}|${pattern}` → count
const text = new Map<string, string>();
for (const abs of sources(SRC)) {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8'); text.set(rel, src);
  const code = strip(src);
  for (const [name, re] of Object.entries(PATTERNS)) {
    const n = (code.match(re) ?? []).length;
    if (n) found.set(`${rel}|${name}`, n);
  }
}

describe('GATE_READS: every shadow/enforce judgment coupling that guards control flow is classified', () => {
  it('no unlisted coupling and no stale entry (classify a new site above; never just bump a count)', () => {
    const registry = new Map(GATE_READS.map((e) => [`${e.file}|${e.pattern}`, e.count]));
    expect(registry.size).toBe(GATE_READS.length); // one entry per file × pattern
    const unlisted = [...found].filter(([k, n]) => registry.get(k) !== n).map(([k, n]) => `${k}: ${n} site(s), registry ${registry.get(k) ?? 'none'}`);
    const stale = [...registry].filter(([k]) => !found.has(k)).map(([k]) => `${k}: listed, not found`);
    expect([...unlisted, ...stale]).toEqual([]);
  });

  it('every gate_read entry still has its deciding line (anchor)', () => {
    for (const e of GATE_READS.filter((x) => x.kind === 'gate_read')) {
      expect(e.anchors?.length, e.file).toBeGreaterThan(0);
      for (const a of e.anchors!) expect(text.get(e.file) ?? '', `${e.file} lost: ${a}`).toContain(a);
    }
  });

  it('the known 2026-10-29 couplings are registered as gate_read', () => {
    const gateReads = GATE_READS.filter((e) => e.kind === 'gate_read').map((e) => e.file);
    expect(gateReads).toEqual(expect.arrayContaining(['services/expert-source-units-service.ts', 'services/loop-auto-merge.ts']));
  });

  it('a judgment-level gate_read is also counted by the value-allocator runtime registry (GATE_READ_JUDGMENTS)', () => {
    for (const e of GATE_READS.filter((x) => x.kind === 'gate_read' && x.judgment)) expect(Object.keys(GATE_READ_JUDGMENTS)).toContain(e.judgment);
  });
});
