import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GymRunPanel, gymRunView, isGymRun, type OutcomeState } from './GymRunPanel';
import type { GymSkillOutcome, LoopRunRecord } from '../lib/api';

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const sha = (c: string) => c.repeat(64);
const SPECIES = 'atomic@llama-router';

function gymRun(id: string, gym: Record<string, unknown>, gym_result?: Record<string, unknown>, extra: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return { id, goal_id: null, loop_name: 'evolution-gym', mode: 'closed', status: gym_result ? 'completed' : 'running', repository_path: '/srv/fixture', state_file: null,
    findings: [], plan: {}, gates: [], next_actions: [], metadata: { gym: { species: SPECIES, remote_host: 'ws1', ...gym }, ...(gym_result ? { gym_result } : {}) },
    created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:05:00Z', completed_at: null, ...extra };
}

const verified = gymRun('run-verified', { commit: 'fail:r1', kind: 'write_test', prod_gates: 1, mutant_keys: ['m1', 'm2', 'm3'], genome: 'g-1' }, {
  status: 'success', reason: 'tests green, source only, kills 2/3 mutants', tokens: null, killed_mutants: ['m1', 'm3'], graded: 0.667, graded_kind: 'mutant_kill',
  prod_gates: { 'test:changed': 'pass', lint: 'pass', 'type-check': 'pass' }, hack_flags: [], diff_ref: `sha256:${sha('a')}`,
  fire_check: { goal_sha256: sha('b'), genome_lines: 2, genome_lines_found: 2 },
});
const red = gymRun('run-red', { commit: 'abc1234', prod_gates: 1 }, { status: 'failure', reason: 'tests still red', tokens: 12_345, hack_flags: [] });
const infra = gymRun('run-infra', { commit: 'def5678' }, { status: 'discarded', reason: 'infra: orphaned_no_result' });
const hack = gymRun('run-hack', { commit: 'fed9876' }, { status: 'quarantined', reason: 'tests green, source only', tokens: 0, hack_flags: ['tests_touched'], diff_ref: `sha256:${sha('c')}` });

const none: OutcomeState = { state: 'loaded', outcome: null };
const outcomeRow = (success: boolean, refs: string[] = []): GymSkillOutcome => ({ id: 'o1', skill_id: 'loop-maker:gym:atomic', success, tokens_used: null, duration_ms: 61_000,
  model: 'llama-router', skill_content_hash: null, evidence_refs: refs, created_at: '2026-10-25T10:05:00Z' });
const scored = (success: boolean, refs: string[] = []): OutcomeState => ({ state: 'loaded', outcome: outcomeRow(success, refs) });

describe('gymRunView: one-line answer per stop class', () => {
  it('a gated success with its per-check map and a mutant kill is verified and counted', () => {
    const v = gymRunView(verified, scored(true));
    expect(v.stop).toBe('verified');
    expect(v.answer).toBe('Verified: prod gates passed, 2/3 mutants killed');
    expect(v.next.label).toBe('counted');
    expect(v.next.detail).toContain('ELIGIBLE_GATED');
  });

  it("red tests are a worker-reported stop, counted as a failure", () => {
    const v = gymRunView(red, scored(false));
    expect(v.stop).toBe('failure');
    expect(v.answer).toBe("Stopped: tests still red after the maker's change (worker report)");
    expect(v.next.label).toBe('counted');
    // the gates run only after a proxy success: not run, not unknown, never "pass"
    expect(v.proven.find((r) => r.label === 'Prod gates')?.value).toBe('not run: the gym oracle failed first');
  });

  it('an orphaned run is an infra discard and the task is served again', () => {
    const v = gymRunView(infra, none);
    expect(v.stop).toBe('lost');
    expect(v.answer).toBe('Infra discard: orphaned_no_result — task will be re-served');
    expect(v.next.label).toBe('served again');
    expect(v.claimed.find((r) => r.label === 'Status')?.value).toBe('no report (the server settled the run)');
  });

  it('a flagged success is quarantined, never shown as a success', () => {
    const v = gymRunView(hack, scored(false, ['gym:quarantined']));
    expect(v.stop).toBe('quarantined');
    expect(v.answer).toBe('Quarantined: the worker reported success, the hack classifier flagged tests_touched');
    expect(v.next.label).toBe('quarantined');
    expect(v.proven.find((r) => r.label === 'Settled as')?.value).toBe('quarantined');
    expect(v.claimed.find((r) => r.label === 'Status')?.value).toBe('success');
  });

  it('a VOID attempt, a non-infra discard, a running run and a legacy row each get their own answer', () => {
    expect(gymRunView(gymRun('v', { commit: 'x', genome: 'g-2' }, { status: 'failure', reason: 'tests still red', void: 'fire_check: no evidence that the genome lines reached the maker' }), none))
      .toMatchObject({ stop: 'void', next: { label: 'served again' } });
    expect(gymRunView(gymRun('t', { commit: 'x' }, { status: 'discarded', reason: 'task: malformed write_test task' }), none))
      .toMatchObject({ stop: 'discarded', answer: 'Discarded: task: malformed write_test task — not scored', next: { label: 'not counted' } });
    expect(gymRunView(gymRun('r', { commit: 'x' }), { state: 'loading' })).toMatchObject({ stop: 'running', answer: 'Running: no result reported yet by ws1', next: { label: 'pending' } });
    expect(gymRunView({ ...gymRun('l', {}), status: 'completed', metadata: {} }, none)).toMatchObject({ stop: 'unknown', answer: 'Unknown: no gym result recorded on this run' });
  });

  it('an ungated success is a proxy success, not verified', () => {
    const v = gymRunView(gymRun('p', { commit: 'x' }, { status: 'success', reason: 'tests green, source only', hack_flags: [], diff_ref: `sha256:${sha('d')}` }), scored(true));
    expect(v.stop).toBe('proxy-success');
    expect(v.answer).toContain('prod gates not run');
    expect(v.next.detail).toContain('never decides headroom or promotion');
  });

  it('unknown values read unknown, never 0: tokens null or a legacy 0, no duration, no kill list', () => {
    for (const run of [verified, hack]) expect(gymRunView(run, none).claimed.find((r) => r.label === 'Tokens')?.value).toBe('unknown (not reported)');
    expect(gymRunView(red, none).claimed.find((r) => r.label === 'Tokens')?.value).toBe('12,345 tokens');
    expect(gymRunView(red, none).claimed.find((r) => r.label === 'Duration')?.value).toBe('unknown (no skill outcome recorded)');
    expect(gymRunView(red, { state: 'loaded', outcome: { ...outcomeRow(false), duration_ms: 0 } }).claimed.find((r) => r.label === 'Duration')?.value).toBe('unknown (not reported)');
    expect(gymRunView(red, scored(false)).claimed.find((r) => r.label === 'Duration')?.value).toBe('61 s');
    const noKills = gymRun('k', { commit: 'x', kind: 'write_test', prod_gates: 1, mutant_keys: ['m1'] }, { status: 'success', reason: 'r', prod_gates: { lint: 'pass' } });
    expect(gymRunView(noKills, none).answer).toBe('Verified: prod gates passed');
  });
});

describe('GymRunPanel', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  const mount = (run: LoopRunRecord, outcome: unknown = { run_id: run.id, skill_outcome: null }) => {
    const fetch = vi.fn(async (url: string) => {
      if (url === `/api/loops/runs/${run.id}/gym-outcome`) return response(outcome);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    render(<GymRunPanel run={run} />);
    return fetch;
  };

  it.each([
    [verified, 'Verified: prod gates passed, 2/3 mutants killed'],
    [red, "Stopped: tests still red after the maker's change (worker report)"],
    [infra, 'Infra discard: orphaned_no_result — task will be re-served'],
    [hack, 'Quarantined: the worker reported success, the hack classifier flagged tests_touched'],
  ])('renders the one-line answer first (%#)', async (run, answer) => {
    mount(run);
    expect(within(await screen.findByTestId('gym-answer')).getByText(answer)).toBeTruthy();
  });

  it('keeps server-side proof and worker claims in separate groups', async () => {
    mount(red, { run_id: red.id, skill_outcome: outcomeRow(false) });
    const proven = await screen.findByTestId('gym-proven');
    const claimed = screen.getByTestId('gym-claimed');
    expect(within(proven).getByRole('heading', { name: 'Proven' })).toBeTruthy();
    expect(within(claimed).getByRole('heading', { name: 'Reported by worker' })).toBeTruthy();
    // the worker's reason and token count appear only under the worker's claims
    expect(within(claimed).getByText('tests still red')).toBeTruthy();
    expect(within(claimed).getByText('12,345 tokens')).toBeTruthy();
    expect(within(proven).queryByText('tests still red')).toBeNull();
    expect(proven.textContent).not.toContain('12,345');
    // the server's settlement and checks appear only under proven
    expect(within(proven).getByText('failure')).toBeTruthy();
    expect(within(proven).getByText('ran, no flags')).toBeTruthy();
    expect(claimed.textContent).not.toContain('ran, no flags');
    expect(await screen.findByText('Skill outcome on record: failure for loop-maker:gym:atomic')).toBeTruthy();
  });

  it('shows unknown tokens as unknown, never 0, and has no interactive control other than the native sources disclosure', async () => {
    mount(hack);
    const claimed = await screen.findByTestId('gym-claimed');
    expect(within(claimed).getByText('unknown (not reported)')).toBeTruthy();
    expect(claimed.textContent).not.toMatch(/\b0 tokens\b/);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('gym-next').textContent).toContain('Next: quarantined');
  });

  it('a failed outcome lookup keeps the panel and reads unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<GymRunPanel run={red} />);
    expect(await screen.findByText('Skill outcome on record: unknown (lookup failed)')).toBeTruthy();
    expect(screen.getByText('unknown (outcome lookup failed)')).toBeTruthy();
  });

  it('applies to evolution-gym and tg-001 runs only', () => {
    expect(['evolution-gym', 'tg-001', 'test-gap'].map((loop_name) => isGymRun({ loop_name }))).toEqual([true, true, false]);
  });
});
