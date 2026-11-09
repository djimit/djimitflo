/**
 * re-20261105 E8 / SYNTHESIS P1-7 ("shadow never acts" FALSIFIED: 17 acting readers of shadow-labelled rows, 12 in no registry).
 * shadow-gate-reads-registry.test.ts greps three code patterns; it never saw SQL. This guard scans every server source file that
 * reads the `judgments` table in SQL (FROM / JOIN judgments) or acts on a judgment-service read helper's verdict, and requires
 * each one to declare its mode policy below:
 *   enforce_only — acts only on an enforce row / under its judgment's enforce mode (shadow rows are recorded, never acted on);
 *   gate_read    — acts on a row whatever its mode label, behind `flags`; every judgment it reads is in GATE_READ_JUDGMENTS
 *                  (or LEARNER_READ_JUDGMENTS for a learner), so the value allocator counts those rows as consumed;
 *   measurement  — report, evidence, display, an experiment readout or the writer's own idempotency: never feeds a decision;
 *   non_shadow   — acts only on judgments that are never written as 'shadow' (annotation, operator_label, an enforce record).
 * An undeclared reader fails, and so does a stale entry. Classify a new reader; never widen a policy to make it pass.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GATE_READ_JUDGMENTS, LEARNER_READ_JUDGMENTS, gateReadPredicate } from '../services/value-allocator';

type Policy = 'enforce_only' | 'gate_read' | 'measurement' | 'non_shadow';
interface Reader { policy: Policy; why: string; judgments?: string[]; flags?: string[] }

const READERS: Record<string, Reader> = {
  // ── gate_read: a shadow-labelled row decides something (operator: see the PR's list before any shadow → enforce change) ──
  'services/loop-daemon.ts': { policy: 'gate_read', judgments: ['auto_approve_shadow'], flags: ['LOOP_AUTO_APPROVE_TEST_GAP'],
    why: "J5: rule-v1's 'yes' (recorded mode='shadow') auto-approves a test-gap maker (autonomy:test-gap-rule-v1) — operator-approved autonomy" },
  'services/expert-source-units-service.ts': { policy: 'gate_read', judgments: ['discovery_relevance'], flags: ['FRONTIER_UNITS_REQUIRE_RELEVANCE', 'ARENA_GATE_ENABLED'],
    why: 'a jev discovery_relevance verdict (shadow) creates an expert unit (promotion); fleetSourceGate skips a source' },
  'services/knowledge-overview.ts': { policy: 'gate_read', judgments: ['discovery_relevance'], flags: ['ARENA_GATE_ENABLED'],
    why: 'sources[] feeds committee-swarm fleetSourceGate (a source with 0 relevant stops being ingested); the rest is display' },
  'services/committee-swarm.ts': { policy: 'gate_read', judgments: ['forecast:resident:*', 'discovery_relevance'], flags: ['ARENA_GATE_ENABLED', 'COMMITTEE_SWARM_ENABLED'],
    why: "arenaGate: no shadow forecast:resident row in 7 d stops scheduling a resident; 'discoveries' recipe puts discovery_relevance 'yes' titles into member prompts" },
  'services/forecast-scoring.ts': { policy: 'gate_read', judgments: ['forecast:resident:*'], flags: ['ARENA_GATE_ENABLED'],
    why: 'forecastScores (shadow forecasts scored on real outcomes) → arenaGate retires a resident worse than the base rate' },
  'services/interest-feedback.ts': { policy: 'gate_read', judgments: ['discovery_relevance', 'kb_retrieval'], flags: ['FEEDBACK_INTERESTS_ENABLED'],
    why: 'scout-term fitness: jev relevance yields and KB retrieval hits pick the interest terms published to the fleet scouts' },
  'services/dream-evolution.ts': { policy: 'gate_read', judgments: ['discovery_relevance'], flags: ['DREAM_EVOLUTION_ENABLED'],
    why: "KE-3: the 3 newest discovery_relevance 'yes' units (30 d) go into the maker-genome mutation prompt" },
  'services/technique-card-service.ts': { policy: 'gate_read', judgments: ['discovery_relevance'], flags: ['FRONTIER_TECHNIQUE_CARDS_ENABLED'],
    why: "fillAbstracts: units with a 'yes' verdict are fetched first (capped per tick)" },
  'services/agent-social-autopilot-service.ts': { policy: 'gate_read', judgments: ['commons_contribution'], flags: ['COMMONS_THREAD_GATE_ENABLED'],
    why: 'threadGated: the last two (shadow) commons_contribution verdicts gate a thread' },
  'services/agent-communication-service.ts': { policy: 'gate_read', judgments: ['failure_cause'], flags: ['COMMONS_AGENDA_FROM_FAILURES'],
    why: 'pickFailureTopic: jev failure_cause rows (shadow) choose the Commons agenda topic; dispositions / grounding stats are display' },
  'services/commons-evidence-pack.ts': { policy: 'gate_read', judgments: ['failure_cause'], flags: ['FRONTIER_UNITS_REQUIRE_RELEVANCE', 'COMMONS_EVIDENCE_PACK_ENABLED'],
    why: 'failure_cause counts become the evidence pack in the discovery_relevance prompt (unit creation) and Commons questions' },
  'services/commons-grounding.ts': { policy: 'gate_read', judgments: ['reflection_triage'], flags: ['COMMONS_AGENDA_GROUNDING'],
    why: 'pickGroundingTopic skips proposals a (shadow) reflection_triage verdict called another system / an aspiration' },
  'services/needs-grounding-triage-service.ts': { policy: 'gate_read', judgments: ['reflection_triage'], flags: ['NEEDS_GROUNDING_TRIAGE_ENABLED'],
    why: 'moves / archives proposals on the latest (shadow) reflection_triage verdict' },
  'services/kb-corpus.ts': { policy: 'gate_read', judgments: ['content_safety', 'kb_passage_relevance'], flags: ['CONTENT_SAFETY_MODE'],
    why: "a kb_page content_safety 'no' quarantines the page in shadow and enforce; kb_passage_relevance drops passages only on an enforce record" },
  'services/dream-state-service.ts': { policy: 'gate_read', judgments: ['failure_cause'], flags: ['DREAM_STATE_ENABLED'],
    why: 'learner: confident failure_cause rows (any mode) recurring ≥ 2× become memory candidates (LEARNER_READ_JUDGMENTS)' },
  // ── enforce_only ──
  'services/content-safety.ts': { policy: 'enforce_only', why: 'gateUntrustedForPrompt excludes text only under CONTENT_SAFETY_MODE=enforce; the rest reuses a verdict / dedupes its own record' },
  'services/decision-context-service.ts': { policy: 'enforce_only', why: "decision_context injects memories only when mode === 'enforce'" },
  'services/self-improvement-auto-review-scheduler.ts': { policy: 'enforce_only', why: 'proposal_prescreen parks only under enforce with an enforce-labelled verdict' },
  // ── non_shadow: the acted-on judgments are never written with mode 'shadow' ──
  'services/outcome-attribution.ts': { policy: 'non_shadow', why: "outcome_attribution is mode 'annotation'; the gating list filters mode = 'enforce'; attribution_audit is operator_label" },
  'services/requeue-policy.ts': { policy: 'non_shadow', why: "attributionOf: outcome_attribution (annotation) picks the requeue class" },
  'services/skill-distillation.ts': { policy: 'non_shadow', why: 'skill cards from outcome_attribution (annotation)' },
  'services/genome-apply.ts': { policy: 'non_shadow', why: "auto-retire reads outcome_attribution (annotation, via nonMakerRunSql); evidence and the stall detector read its own genome_apply_retire records (enforce)" },
  'services/knowledge-gaps.ts': { policy: 'non_shadow', why: "outcome_attribution (annotation) leaves runs out; knowledge_gap reads are the writer's own dedupe / list" },
  'services/web-research.ts': { policy: 'non_shadow', why: "outcome_attribution (annotation) leaves runs out; web_research rows are the job's own bookkeeping (in flight, cap, re-ask); only web_research_knowledge rows (mode 'on', written under WEB_RESEARCH_MODE=on) reach the dream pack" },
  'services/improvement-requeue.ts': { policy: 'non_shadow', why: "prescreen_park is written 'enforce' (only when the prescreen actually parked)" },
  'services/self-improvement-service.ts': { policy: 'non_shadow', why: "panel_failed / prescreen_park are written 'enforce'" },
  'services/decisions-inbox.ts': { policy: 'non_shadow', why: "requeue_dismiss (enforce, operator) filters requeue candidates; prescreen rows and labels are shown to the operator" },
  'services/capability-factory.ts': { policy: 'non_shadow', why: "capability_request rows are the factory's own records, mode 'on'" },
  // ── measurement ──
  'services/lane-policy.ts': { policy: 'measurement', why: 'lane_policy shadow readout: counts its own rows for the evidence section, never feeds a decision (#1159)' },
  'services/explainer-mermaid-service.ts': { policy: 'measurement', why: 'mermaid_validate shadow: reads its own rows for dedupe, the daily credit cap and the readout; never feeds a product decision (#1156)' },
  'services/judgment-service.ts': { policy: 'measurement', why: 'the runner: records verdicts, returns them to the callers listed here' },
  'services/autonomy-shadow-service.ts': { policy: 'measurement', why: "dedupe of its own auto_approve_shadow row (the verdict acts in loop-daemon, declared above); risk_atomic fire-and-forget" },
  'services/loop-worker-executor-service.ts': { policy: 'measurement', why: 'checker second opinion recorded, never a verdict' },
  'services/ace-001.ts': { policy: 'measurement', why: 'proposal_embedding error → ACE fallback reason label' },
  'services/advisory-exposure.ts': { policy: 'measurement', why: 'own dedupe + evidence' },
  'services/auto-requeue.ts': { policy: 'measurement', why: 'dedupe of its own shadow would_* rows' },
  'services/checker-family.ts': { policy: 'measurement', why: 'F2 arm evidence' },
  'services/commons-investigation.ts': { policy: 'measurement', why: 'own dedupe' },
  'services/content-drafts.ts': { policy: 'measurement', why: 'own daily cap / dedupe + evidence' },
  'services/cost-ledger.ts': { policy: 'measurement', why: 'token ledger' },
  'services/d5-no.ts': { policy: 'measurement', why: 'D5-NO experiment readout' },
  'services/discovery-relevance-labels.ts': { policy: 'measurement', why: 'operator relevance labels' },
  'services/dream-evidence-sources.ts': { policy: 'measurement', why: 'evidence' },
  'services/e1-retrieval-labels.ts': { policy: 'measurement', why: 'E1 labelling tasks' },
  'services/effort-controller.ts': { policy: 'measurement', why: 'shadow-only effort record' },
  'services/evolution-feedback.ts': { policy: 'measurement', why: 'evolution digest (report)' },
  'services/evolution-lineage.ts': { policy: 'measurement', why: 'label counts' },
  'services/fleet-repair.ts': { policy: 'measurement', why: 'own shadow candidates + evidence' },
  'services/forecasters.ts': { policy: 'measurement', why: 'calibrates a prescreen p into another shadow forecast; own dedupe' },
  'services/honest-numbers.ts': { policy: 'measurement', why: 'report' },
  'services/improvement-funnel-service.ts': { policy: 'measurement', why: 'funnel agreement report' },
  'services/intelligence-metrics.ts': { policy: 'measurement', why: 'metrics' },
  'services/jev-challenger.ts': { policy: 'measurement', why: 'JEV-114 paired readout' },
  'services/knowledge-fitness.ts': { policy: 'measurement', why: 'knowledge fitness report (overview, dedupe report)' },
  'services/loop-auto-merge-state.ts': { policy: 'measurement', why: 'value-gate replay counts' },
  'services/memory-template-dedup.ts': { policy: 'measurement', why: 'count of its own rows' },
  'services/mission-detail.ts': { policy: 'measurement', why: 'display' },
  'services/negative-evidence-check.ts': { policy: 'measurement', why: 'evidence' },
  'services/operator-cockpit.ts': { policy: 'measurement', why: 'cockpit' },
  'services/panel-calibration-shadow.ts': { policy: 'measurement', why: 'own dedupe' },
  'services/pl-001.ts': { policy: 'measurement', why: 'last freeze refusal (display)' },
  'services/procedure-selector.ts': { policy: 'measurement', why: 'evidence' },
  'services/provenance-dag.ts': { policy: 'measurement', why: 'provenance report' },
  'services/resource-scheduler.ts': { policy: 'measurement', why: 'own shadow dedupe + evidence' },
  'services/settlement-execution.ts': { policy: 'measurement', why: 'own retry bookkeeping + settlement evidence' },
  'services/spec-gap-source.ts': { policy: 'measurement', why: 'own dedupe + evidence' },
  'services/stall-watch.ts': { policy: 'measurement', why: "health monitor: judgment error rates and its own 'stall' annotations" },
  'services/telegram-bot-service.ts': { policy: 'measurement', why: 'operator labels a recorded prescreen rejection' },
  'services/training-dataset.ts': { policy: 'measurement', why: 'dataset export' },
  'services/value-allocator.ts': { policy: 'measurement', why: 'the GATE_READ_JUDGMENTS accounting itself' },
};

/** judgment-service read helpers whose returned verdict a caller may act on */
const READ_HELPERS = /\b(?:runJudgments?|localShadow|recordAutoApproveShadow)\(/;
const SQL_READ = /\b(?:FROM|JOIN)\s+judgments\b/i;
const SRC = path.resolve(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = new Map(sources(SRC).map((abs) => [path.relative(SRC, abs).split(path.sep).join('/'), strip(fs.readFileSync(abs, 'utf8'))]));
const readers = [...code].filter(([, c]) => SQL_READ.test(c) || READ_HELPERS.test(c)).map(([f]) => f).sort();
const allCode = [...code.values()].join('\n');

describe('judgments readers: every file that reads judgments declares its mode policy', () => {
  it('no undeclared reader and no stale entry', () => {
    const undeclared = readers.filter((f) => !READERS[f]).map((f) => `${f}: reads judgments, no policy declared`);
    const stale = Object.keys(READERS).filter((f) => !readers.includes(f)).map((f) => `${f}: declared, reads no judgments`);
    expect([...undeclared, ...stale]).toEqual([]);
  });

  it('a gate_read names its flags (read in code) and every judgment it acts on is in the runtime registry', () => {
    const problems: string[] = [];
    for (const [f, r] of Object.entries(READERS).filter(([, x]) => x.policy === 'gate_read')) {
      if (!r.flags?.length || !r.judgments?.length) { problems.push(`${f}: gate_read needs flags and judgments`); continue; }
      for (const flag of r.flags) if (!new RegExp(`\\benv\\.${flag}\\b|\\benv\\[['"]${flag}['"]\\]`).test(allCode)) problems.push(`${f}: flag ${flag} is read nowhere`);
      for (const j of r.judgments) if (!gateReadPredicate(j) && !LEARNER_READ_JUDGMENTS[j]) problems.push(`${f}: ${j} not in GATE_READ_JUDGMENTS / LEARNER_READ_JUDGMENTS`);
    }
    expect(problems).toEqual([]);
  });

  it('an enforce_only reader names enforce in code', () => {
    for (const [f, r] of Object.entries(READERS)) if (r.policy === 'enforce_only') expect(code.get(f) ?? '', f).toMatch(/'enforce'/);
  });

  it('the re-20261105 E8 acting-on-shadow couplings are declared gate_read', () => {
    for (const f of ['services/loop-daemon.ts', 'services/expert-source-units-service.ts', 'services/knowledge-overview.ts', 'services/committee-swarm.ts',
      'services/interest-feedback.ts', 'services/dream-evolution.ts']) expect(READERS[f]?.policy, f).toBe('gate_read');
    expect(Object.keys(GATE_READ_JUDGMENTS)).toEqual(expect.arrayContaining(['auto_approve_shadow', 'discovery_relevance', 'forecast:resident:*']));
  });
});
