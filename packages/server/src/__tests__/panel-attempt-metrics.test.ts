import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { panelAttemptMetrics, MIN_SEMANTIC_N } from '../services/panel-attempt-metrics';
import { commonsChildOutcomes } from '../services/honest-numbers';

// E4: attempt-level panel metrics — operational reliability (P(valid | model, prompt, provider)) apart from semantic quality
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

const now = Date.parse('2026-10-12T12:00:00Z');
const at = new Date(now - 86_400_000).toISOString();
const panel = (id: string, decision: string) => db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, consensus_json, created_at)
  VALUES (?, 't', 'q', 'consensus_ready', 'high', ?, ?)`).run(id, JSON.stringify({ decision }), at);
const review = (panelId: string, seat: string, r: { model?: string | null; attempt?: number | null; stance?: string; confidence?: number; findings?: string[] }) =>
  db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, status, model, prompt_sha256, attempt, created_at)
    VALUES (?, ?, ?, 'T', ?, ?, ?, 'submitted', ?, ?, ?, ?)`).run(`${panelId}:${seat}`, panelId, seat, r.stance ?? 'support', r.confidence ?? 0.8,
    JSON.stringify(r.findings ?? ['checked']), r.model === undefined ? 'm1' : r.model, r.attempt === null ? null : `p-${panelId}-${seat}`, r.attempt === undefined ? 1 : r.attempt, at);
const quarantine = (panelId: string, seat: string, error: string, model = 'm1') => db.prepare(`INSERT INTO specialist_review_quarantine
  (id, panel_id, specialist_id, model, prompt_sha256, error, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, 2, ?)`)
  .run(`${panelId}:${seat}:${error.slice(0, 12)}`, panelId, seat, model, `p-${panelId}-${seat}`, error, at);
const call = (status: string, provider = 'ollama', shadow = 0) => db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, shadow, provider, status, created_at)
  VALUES ('panel_review', 'm1', ?, ?, ?, ?, ?)`).run(status === 'ok' || status === 'repaired' ? 1 : 0, shadow, provider, status, at);

function fixture() {
  panel('P1', 'goal');
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES ('si-1', 'x', 't', 'd', 'r', 'test', 'verified', 'P1')`).run();
  review('P1', 'a', { attempt: 1, stance: 'support' }); // first pass, correct against the verified outcome
  review('P1', 'b', { attempt: 2, stance: 'oppose' }); // recovered by the re-ask
  quarantine('P1', 'c', 'answer is not valid JSON');
  quarantine('P1', 'd', 'stance must be one of support|oppose|uncertain|needs_evidence (got "approve")');
  quarantine('P1', 'e', 'generation failed: empty model response (timed out)');
  quarantine('P1', 'f', 'generation failed: Ollama request failed: 404');
  quarantine('P1', 'g', 'something nobody wrote');
  // pre-#784: a coerced 'could not be parsed' review without provenance
  review('P1', 'legacy', { model: null, attempt: null, stance: 'needs_evidence', confidence: 0, findings: ['Model response could not be parsed: garbage'] });
  for (const s of ['ok', 'ok', 'repaired', 'invalid_parse', 'invalid_schema', 'invalid', 'empty', 'error']) call(s);
  call('ok', 'ollama', 1);
  call('ok', 'litellm');
}

it('derives one state per attempt with n_attempt / n_valid next to every rate; retry is not first pass', () => {
  fixture();
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.seat_attempts.groups).toHaveLength(1);
  const g = m.seat_attempts.groups[0];
  expect(g).toMatchObject({ model: 'm1', model_version: 'UNKNOWN', prompt_fingerprint: 'UNKNOWN', provider: 'UNKNOWN', prompt_instances: 7,
    n_attempt: 7, n_valid: 2, n_first_pass: 1, n_after_retry: 1, n_quarantined: 5 });
  expect(g.states).toMatchObject({ VALID_FIRST_PASS: 1, VALID_AFTER_RETRY: 1, PARSE_FAILED: 1, SCHEMA_INVALID: 1, GENERATION_FAILED: 1, INFRA_FAILED: 1,
    QUARANTINED: 1, UNKNOWN_FAILURE: 0, 'PARSE_FAILED|SCHEMA_INVALID': 0 });
  expect(g.reliability).toMatchObject({ value: +(2 / 7).toFixed(4), n_attempt: 7, n_valid: 2 });
  expect(g.first_pass).toMatchObject({ value: +(1 / 7).toFixed(4), n_attempt: 7, n_first_pass: 1 });
  // the legacy coerced row is its own class, never an attempt
  expect(m.legacy).toEqual({ coerced_unparseable: 1, coerced_generation_failed: 0, unprovenanced: 0 });
  expect(m.seat_attempts.totals).toMatchObject({ n_attempt: 7, n_valid: 2, n_quarantined: 5 });
  expect(m.unreadable).toEqual([]);
  expect(m.window_days).toBe(7);
});

it('model calls group by model × provider; pre-E4 invalid stays the combined class; shadow counted apart', () => {
  fixture();
  const { model_calls } = panelAttemptMetrics(db, { days: 7, now });
  expect(model_calls.recorded).toBe(true);
  const ollama = model_calls.groups.find((x) => x.provider === 'ollama');
  const litellm = model_calls.groups.find((x) => x.provider === 'litellm');
  expect(ollama).toMatchObject({ model: 'm1', prompt_fingerprint: 'UNKNOWN', n_attempt: 9, n_valid: 4, n_first_pass: 3, n_after_retry: 1, n_shadow: 1, n_quarantined: null });
  expect(ollama?.states).toMatchObject({ PARSE_FAILED: 1, SCHEMA_INVALID: 1, 'PARSE_FAILED|SCHEMA_INVALID': 1, GENERATION_FAILED: 1, INFRA_FAILED: 1 });
  expect(ollama?.reliability).toMatchObject({ value: +(4 / 9).toFixed(4), n_attempt: 9, n_valid: 4 });
  expect(litellm).toMatchObject({ n_attempt: 1, n_valid: 1, reliability: { value: 1, n_attempt: 1, n_valid: 1 } });
  expect(ollama?.semantic_quality).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', value: null, n_semantically_scored: 0 });
});

it('semantic quality is INSUFFICIENT_EVIDENCE (null, never 0) without enough ground truth; panel agreement is marked circular', () => {
  fixture();
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.semantic_quality).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', value: null, n_valid: 2, n_semantically_scored: 2, circular: false });
  expect(g.panel_agreement).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', value: null, n_semantically_scored: 2, circular: true });

  // no proposal outcome at all: still INSUFFICIENT, with 0 scored — not a 0 % quality
  db.prepare("UPDATE self_improvements SET status = 'proposed'").run();
  expect(panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0].semantic_quality).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', value: null, n_semantically_scored: 0 });
});

it('with enough outcome-labelled valid reviews the conditional quality is P(correct | valid)', () => {
  for (let i = 0; i < MIN_SEMANTIC_N; i++) {
    panel(`Q${i}`, 'goal');
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES (?, 'x', 't', 'd', 'r', 'test', ?, ?)`)
      .run(`si-${i}`, i < 7 ? 'verified' : 'regressed', `Q${i}`);
    review(`Q${i}`, 'a', { attempt: 1, stance: 'support' });
  }
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.semantic_quality).toMatchObject({ status: 'ok', value: 0.7, n_valid: 10, n_semantically_scored: 10 });
  expect(g.n_first_pass).toBe(10);
  expect(g.n_after_retry).toBe(0);
  expect(g.panel_agreement).toMatchObject({ status: 'ok', value: 1, circular: true });
});

it('a missing source is named unreadable, not read as 0 attempts', () => {
  db.exec('DROP TABLE specialist_review_quarantine');
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.unreadable).toEqual(['specialist_review_quarantine']);
  expect(m.model_calls.recorded).toBe(false);
});

it('the writer records parse vs schema on the ledger row (invalid_parse / invalid_schema)', async () => {
  for (const [k, v] of Object.entries({ MODEL_SELECTOR_MODE: 'shadow', MODEL_SELECTOR_SHADOW_RATE: '0', SELF_IMPROVEMENT_REVIEW_MODEL: 'm1' })) vi.stubEnv(k, v);
  const panels = new SpecialistPanelService(db);
  const p = panels.createPanel({ topic: 'T', question: 'Q', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'], context: { description: 'd' } });
  let n = 0;
  // seat 1: prose twice (parse); seat 2: JSON with an out-of-set stance twice (schema)
  const reviewer = new SelfImprovementAgentReviewService(db, async () => (n++ < 2 ? 'Sure, looks fine.' : JSON.stringify({ stance: 'approve', confidence: 0.9, findings: ['x'], evidence_refs: ['context:d'] })));
  await reviewer.reviewMissingSpecialists(p.id, 'run-1');
  const statuses = (db.prepare("SELECT status FROM llm_model_calls WHERE consumer = 'panel_review' ORDER BY id").all() as Array<{ status: string }>).map((r) => r.status);
  expect(statuses).toEqual(['invalid_parse', 'invalid_schema']);
  const m = panelAttemptMetrics(db, { days: 7 });
  expect(m.seat_attempts.totals.states).toMatchObject({ PARSE_FAILED: 1, SCHEMA_INVALID: 1 });
  expect(m.model_calls.groups[0].states).toMatchObject({ PARSE_FAILED: 1, SCHEMA_INVALID: 1 });
});

it('AC-03: the Commons projection reads the same legacy rows as a technical review failure; a quarantine-only panel is one too', () => {
  fixture(); // P1: valid reviews next to one legacy coerced row
  const grounded = (n: string, panelId: string) => {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES (?, 'x', 't', 'd', 'r', 'refinement', 'archived', ?)`).run(`kid-${n}`, panelId);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'commons_grounding', 'self_improvement', ?, 'h', 'enforce', 'yes', 'r', ?, ?)`).run(`g-${n}`, `parent-${n}`, JSON.stringify({ refinement_id: `kid-${n}` }), at);
  };
  panel('P2', 'needs_more_evidence'); // pre-#784: both seats coerced
  for (const s of ['a', 'b']) review('P2', s, { model: null, attempt: null, stance: 'needs_evidence', confidence: 0, findings: ['Model response could not be parsed: x'] });
  panel('P3', 'needs_more_evidence'); // current contract: both seats quarantined and closed, no review row
  for (const s of ['a', 'b']) db.prepare(`INSERT INTO specialist_review_quarantine (id, panel_id, specialist_id, model, error, attempt, closes_seat, created_at)
    VALUES (?, 'P3', ?, 'm1', 'answer is not valid JSON', 2, 1, ?)`).run(`P3:${s}`, s, at);
  grounded('1', 'P1'); grounded('2', 'P2'); grounded('3', 'P3');
  const m = panelAttemptMetrics(db, { days: 7, now });
  const c = commonsChildOutcomes(db)!;
  expect(m.legacy.coerced_unparseable).toBe(3);
  expect(c.legacy_fallback_reviews).toBe(3);
  // P1 had valid reviews (its stored decision is 'goal' but no goal row exists): not a technical failure
  expect(c.outcomes).toMatchObject({ technical_failure: 2, pending: 1 });
});

it('an unknown ledger status maps to UNKNOWN_FAILURE (the default case)', () => {
  call('something-unrecognised');
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.model_calls.groups[0].states.UNKNOWN_FAILURE).toBe(1);
});

it('pre-#784 legacy rows: coerced generation failed and unprovenanced are classified apart from coerced unparseable', () => {
  panel('PL', 'goal');
  review('PL', 'genfail', { model: null, attempt: null, stance: 'needs_evidence', confidence: 0, findings: ['Review generation failed: timeout'] });
  review('PL', 'unprov', { model: null, attempt: null, stance: 'needs_evidence', confidence: 0, findings: ['random text'] });
  review('PL', 'parsed', { model: null, attempt: null, stance: 'needs_evidence', confidence: 0, findings: ['Model response could not be parsed: x'] });
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.legacy).toEqual({ coerced_unparseable: 1, coerced_generation_failed: 1, unprovenanced: 1 });
  expect(m.seat_attempts.totals.n_attempt).toBe(0);
});

it('uncertain / needs_evidence stances are valid but never semantically scored', () => {
  panel('PU', 'goal');
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES ('si-u', 'x', 't', 'd', 'r', 'test', 'verified', 'PU')`).run();
  review('PU', 'a', { attempt: 1, stance: 'uncertain' });
  review('PU', 'b', { attempt: 1, stance: 'needs_evidence' });
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.n_valid).toBe(2);
  expect(g.semantic_quality.n_semantically_scored).toBe(0);
  expect(g.panel_agreement.n_semantically_scored).toBe(0);
});

it('an oppose stance on a verified outcome is scored as incorrect for both quality and agreement', () => {
  for (let i = 0; i < MIN_SEMANTIC_N; i++) {
    panel(`Q${i}`, 'goal');
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES (?, 'x', 't', 'd', 'r', 'test', 'verified', ?)`)
      .run(`si-${i}`, `Q${i}`);
    review(`Q${i}`, 'a', { attempt: 1, stance: i < 3 ? 'oppose' : 'support' });
  }
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.semantic_quality).toMatchObject({ status: 'ok', value: 0.7, n_semantically_scored: 10 });
  expect(g.panel_agreement).toMatchObject({ status: 'ok', value: 0.7, n_semantically_scored: 10 });
});

it('panel agreement: blocked makes support wrong; backlog scores like goal; both are scored', () => {
  for (let i = 0; i < MIN_SEMANTIC_N; i++) {
    const dec = i < 5 ? 'blocked' : 'backlog';
    panel(`B${i}`, dec);
    review(`B${i}`, 'a', { attempt: 1, stance: i < 5 ? 'support' : 'oppose' });
  }
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.panel_agreement).toMatchObject({ status: 'ok', value: 0, n_semantically_scored: 10 });
});

it('a non-scored consensus decision (needs_more_evidence) is not counted in panel agreement', () => {
  for (let i = 0; i < MIN_SEMANTIC_N + 1; i++) {
    panel(`N${i}`, i === 0 ? 'needs_more_evidence' : 'goal');
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id) VALUES (?, 'x', 't', 'd', 'r', 'test', 'verified', ?)`)
      .run(`si-${i}`, `N${i}`);
    review(`N${i}`, 'a', { attempt: 1, stance: 'support' });
  }
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.panel_agreement.n_semantically_scored).toBe(10);
});

it('a quarantine row without prompt_sha256 does not inflate prompt_instances', () => {
  panel('PQ', 'goal');
  db.prepare(`INSERT INTO specialist_review_quarantine (id, panel_id, specialist_id, model, prompt_sha256, error, attempt, created_at)
    VALUES (?, 'PQ', 's', 'm1', NULL, 'answer is not valid JSON', 2, ?)`).run('PQ:s', at);
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.prompt_instances).toBe(0);
});

it('a review without prompt_sha256 does not inflate prompt_instances', () => {
  panel('PR', 'goal');
  db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, status, model, prompt_sha256, attempt, created_at)
    VALUES (?, 'PR', 's', 'T', 'support', 0.8, '[]', 'submitted', 'm1', NULL, 1, ?)`).run('PR:s', at);
  const g = panelAttemptMetrics(db, { days: 7, now }).seat_attempts.groups[0];
  expect(g.prompt_instances).toBe(0);
});

it('seat groups are sorted by n_attempt descending (insertion order differs)', () => {
  panel('S1', 'goal'); review('S1', 'a', { model: 'small', attempt: 1 });
  panel('S2', 'goal'); review('S2', 'a', { model: 'big1', attempt: 1 });
  panel('S3', 'goal'); review('S3', 'a', { model: 'big1', attempt: 1 });
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.seat_attempts.groups.map((g) => g.model)).toEqual(['big1', 'small']);
});

it('model call groups are sorted by n_attempt descending (insertion order differs)', () => {
  call('ok', 'litellm');
  call('ok', 'ollama'); call('ok', 'ollama');
  const m = panelAttemptMetrics(db, { days: 7, now });
  expect(m.model_calls.groups.map((g) => g.provider)).toEqual(['ollama', 'litellm']);
});
