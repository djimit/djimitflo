import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, prepareState, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment, band } from '../services/judgment-service';
import { namedPathsExist, proposalPrescreen } from '../services/judgments/proposal-prescreen';
import { join } from 'path';

let db: Database.Database;
const noul = (p: number) => ({ type: 'noul', noul: p });
const ok = (answers: Record<string, unknown>) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 20 } }) });
const client = (f: ReturnType<typeof vi.fn>) => new TypeSafeClient(f as unknown as typeof fetch);

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE; db.close(); });

it('band: three tiers around the uncertain zone', () => {
  expect([band(0.1, 0.3, 0.7), band(0.5, 0.3, 0.7), band(0.9, 0.3, 0.7), band(undefined, 0.3, 0.7)]).toEqual(['no', 'uncertain', 'yes', 'uncertain']);
});
it('redacts secrets and caps size before state leaves the host', () => {
  const s = prepareState({ note: 'use apikey_2106f771d939d24244d8a8889ae8 and password: hunter2 now', big: 'x'.repeat(100_000) });
  expect(s.note).not.toContain('apikey_2106'); expect(s.note).not.toContain('hunter2'); expect(s.big.length).toBe(60_000);
});
it('is off by default and without a key: no call, no record', async () => {
  const f = ok({}); delete process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE;
  expect(await runJudgment(db, proposalPrescreen, { type: 't', id: '1' }, {}, client(f))).toBeNull();
  process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'shadow'; delete process.env.TYPESAFE_API_KEY;
  expect(await runJudgment(db, proposalPrescreen, { type: 't', id: '1' }, {}, client(f))).toBeNull();
  expect(f).not.toHaveBeenCalled(); expect(db.prepare('SELECT COUNT(*) n FROM judgments').get()).toEqual({ n: 0 });
});
it('records the decision, tokens and pinned model; decides yes/no/uncertain from the answers', async () => {
  const yes = await runJudgment(db, proposalPrescreen, { type: 'self_improvement', id: 'p1' }, { proposal: { title: 't' } }, client(ok({ names_file: noul(0.95), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.05) })));
  expect(yes).toMatchObject({ decision: 'yes', mode: 'shadow' });
  expect((await runJudgment(db, proposalPrescreen, { type: 'self_improvement', id: 'p2' }, {}, client(ok({ names_file: noul(0.1), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.05) }))))?.decision).toBe('no');
  expect((await runJudgment(db, proposalPrescreen, { type: 'self_improvement', id: 'p3' }, {}, client(ok({ names_file: noul(0.95), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.9) }))))?.decision).toBe('uncertain');
  expect(db.prepare("SELECT decision, input_tokens, model FROM judgments WHERE subject_id = 'p1'").get()).toEqual({ decision: 'yes', input_tokens: 300, model: 'jev-1.13.0' });
});
it('fail-open: an API error returns null, is recorded, and the breaker opens after repeated failures', async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  const c = new TypeSafeClient(f as unknown as typeof fetch);
  for (let i = 0; i < 3; i += 1) expect(await runJudgment(db, proposalPrescreen, { type: 't', id: `e${i}` }, {}, c)).toBeNull();
  const calls = f.mock.calls.length;
  expect(await runJudgment(db, proposalPrescreen, { type: 't', id: 'e-open' }, {}, c)).toBeNull();
  expect(f.mock.calls.length).toBe(calls); // breaker open: no further requests
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE decision = 'error'").get()).toEqual({ n: 4 });
}, 20_000);
it('file existence is checked in code, not asked of the model', async () => {
  const root = join(__dirname, '..', '..', '..', '..');
  expect(namedPathsExist('touch packages/server/src/services/judgment-service.ts', root)).toBe(true);
  expect(namedPathsExist('touch packages/server/src/services/does-not-exist.ts', root)).toBe(false);
  expect(namedPathsExist('improve reliability in general', root)).toBeUndefined();
  expect(namedPathsExist('see ../../../etc/passwd.md', root)).toBe(false);
  const answers = { names_file: noul(0.95), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.05) };
  expect((await runJudgment(db, proposalPrescreen, { type: 't', id: 'x1' }, {}, client(ok(answers)), { pathExists: false }))?.reason).toBe('named file does not exist in the repository');
  expect((await runJudgment(db, proposalPrescreen, { type: 't', id: 'x2' }, {}, client(ok(answers)), { pathExists: true }))?.decision).toBe('yes');
});
