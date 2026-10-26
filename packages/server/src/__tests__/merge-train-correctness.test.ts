import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

// scripts/merge-train.sh correctness (operator directive 2026-10-12): draft handling (A), stale head after update-branch (B),
// bounded CI wait (C), failure modes, and a read-only --dry-run. GitHub is simulated with probe overrides (MT_<NAME>) over
// state files, or with a stub `gh` on PATH for the real code paths; main is a real temporary git repo.
const script = path.resolve(__dirname, '../../../../scripts/merge-train.sh');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (cwd: string, cmd: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const git = (cwd: string, args: string) => {
  const r = sh(cwd, `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`);
  if (r.status !== 0) throw new Error(`git ${args}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const lines = (f: string) => read(f).split('\n').filter(Boolean);
const events = (ledger: string) => lines(ledger).map((l) => JSON.parse(l) as { event: string; head: string; detail: string });
const isAuditSample = (n: number) => crypto.createHash('sha256').update(`loop-auto-merge:${n}`).digest().readUInt32BE(0) % 100 < 10;

function mainRepo() {
  const dir = tmp('mtc-main-');
  git(dir, 'init -q -b main');
  write(dir, 'x.txt', 'old\n'); git(dir, 'add -A'); git(dir, 'commit -q -m base');
  git(dir, 'checkout -q -b pr');
  write(dir, 'x.txt', 'new\n'); write(dir, 'x.test.ts', 'it("x", () => {});\n'); git(dir, 'add -A'); git(dir, 'commit -q -m change');
  const diff = path.join(dir, '..', `${path.basename(dir)}.diff`); fs.writeFileSync(diff, sh(dir, 'git diff main pr').stdout);
  git(dir, 'checkout -q main');
  return { dir, diff };
}

// A simulated PR: state files S/{state,head,draft,behind,ci-<sha>,ci-new}; every gh-facing probe appends to S/calls.
// GitHub semantics kept: update-branch moves the head only when behind; merge refuses a draft or a sha that is not the head.
function sim(o: { draft?: boolean; behind?: boolean; ciNew?: string; ci?: Record<string, string> } = {}) {
  const { dir, diff } = mainRepo();
  const S = tmp('mtc-sim-');
  write(S, 'state', 'OPEN\n'); write(S, 'head', 'aaaa1111\n'); write(S, 'draft', `${o.draft ? 'true' : 'false'}\n`);
  if (o.behind ?? true) write(S, 'behind', '');
  if (o.ciNew !== undefined) write(S, 'ci-new', `${o.ciNew}\n`);
  for (const [sha, v] of Object.entries(o.ci ?? {})) write(S, `ci-${sha}`, `${v}\n`);
  const ledger = path.join(tmp('mtc-led-'), 'ledger.jsonl');
  const env: Record<string, string> = {
    MT_LEDGER: ledger, MT_BASE: 'main', MT_FETCH: 'true', MT_SLEEP: 'true', MT_PR_DIFF: `cat ${diff}`,
    MT_PR_VIEW: `echo "$(cat ${S}/state) $(cat ${S}/head) $(cat ${S}/draft)"`,
    MT_READY: `echo ready >> ${S}/calls; echo false > ${S}/draft`,
    MT_UPDATE: `echo "update $6" >> ${S}/calls; if [ -f ${S}/behind ]; then rm ${S}/behind; echo "$(cat ${S}/head)-u" > ${S}/head; echo '{"message":"Updating pull request branch."}'; else echo 'gh: There are no new commits on the base branch. (HTTP 422)' >&2; exit 1; fi`,
    MT_CHECKS: `echo "checks $6" >> ${S}/calls; if [ -f ${S}/ci-$6 ]; then cat ${S}/ci-$6; else cat ${S}/ci-new 2>/dev/null || echo pending; fi`,
    MT_MERGE: `echo "merge $6" >> ${S}/calls; if [ "$(cat ${S}/draft)" = true ] || [ "$6" != "$(cat ${S}/head)" ]; then echo 'refused: head or draft' >&2; exit 1; fi; git apply ${diff} && git add -A && git -c user.email=t@t -c user.name=t commit -q -m squash && echo MERGED > ${S}/state`,
  };
  return { dir, diff, S, ledger, env, calls: () => lines(path.join(S, 'calls')) };
}
type Sim = ReturnType<typeof sim>;
const run = (s: Sim, args: string[], over: Record<string, string> = {}, timeout = 20_000) => {
  const r = spawnSync('bash', [script, ...args], { cwd: s.dir, env: { ...process.env, ...s.env, ...over }, encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const train = (s: Sim, prs: string[], flags: string[] = [], over: Record<string, string> = {}) => run(s, ['run', ...flags, path.join(s.S, 'log'), ...prs], over);
const counter = (file: string, first: string, rest: string) => `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; if [ "$n" = 0 ]; then echo ${first}; else echo ${rest}; fi`;

describe('audit consistency regressions', () => {
  it('a failed diff download with a usable partial patch holds before mutation', () => {
    const s = sim({ behind: false, ciNew: 'pass' });
    const r = train(s, ['778'], [], { MT_PR_DIFF: `cat ${s.diff}; exit 1` });
    expect(r.status).toBe(7);
    expect(s.calls()).toEqual([]);
  });

  it('a head changed during diff download is superseded before any mutation', () => {
    const s = sim({ behind: false, ciNew: 'pass' });
    const r = train(s, ['778'], [], { MT_PR_DIFF: `cat ${s.diff}; echo bbbb2222 > ${s.S}/head` });
    expect(r.status).toBe(5);
    expect(s.calls()).toEqual([]);
  });

  it('an accepted update without an observed new head holds without reusing old CI', () => {
    const s = sim({ ci: { aaaa1111: 'pass' } });
    const r = train(s, ['778'], [], { MT_UPDATE: 'echo accepted', MT_HEAD_SETTLE_S: '1', MT_HEAD_SETTLE_POLL_S: '1' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('new head');
    expect(s.calls()).toEqual([]);
  });

  for (const failingFetch of [1, 2, 3]) {
    it(`a failed main refresh at stage ${failingFetch} never reports verified completion`, () => {
      const s = sim({ behind: false, ciNew: 'pass' });
      const n = path.join(s.S, 'fetch-count');
      const r = train(s, ['778'], [], { MT_FETCH: `n=$(cat ${n} 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > ${n}; [ "$n" != ${failingFetch} ]` });
      expect(r.status).toBe(7);
      expect(events(s.ledger).map((e) => e.event)).not.toContain('merged');
      if (failingFetch < 3) expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
      else expect(read(path.join(s.S, 'state')).trim()).toBe('MERGED');
    });
  }
});

describe('Defect A — drafts', () => {
  it('a draft without --mark-ready is HELD with the ready transition proposed; draft state, branch and merge untouched', () => {
    const s = sim({ draft: true, ciNew: 'pass' });
    const r = train(s, ['778'], [], { MT_POLICY: 'echo READY' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('HOLD');
    expect(r.out).toContain('--mark-ready');
    expect(read(path.join(s.S, 'draft')).trim()).toBe('true');
    expect(s.calls().filter((c) => /^(ready|update|merge)/.test(c))).toEqual([]);
    expect(events(s.ledger).map((e) => e.event)).toContain('hold');
  });

  it('a draft whose policy/evidence verdict is not READY is HELD even with --mark-ready; it stays a draft', () => {
    const s = sim({ draft: true, ciNew: 'pass' });
    const r = train(s, ['778'], ['--mark-ready'], { MT_POLICY: 'echo ASSERTION_BLOCKED' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('ASSERTION_BLOCKED');
    expect(read(path.join(s.S, 'draft')).trim()).toBe('true');
    expect(s.calls().filter((c) => /^(ready|update|merge)/.test(c))).toEqual([]);
  });

  it('a READY draft with --mark-ready: ready → update-branch → CI on the NEW head → merge of exactly that head', () => {
    const s = sim({ draft: true, ciNew: 'pass' });
    const r = train(s, ['778'], ['--mark-ready'], { MT_POLICY: 'echo READY' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('#778 MERGED');
    expect(s.calls()).toEqual(['ready', 'update aaaa1111', 'checks aaaa1111-u', 'merge aaaa1111-u']);
    expect(events(s.ledger).map((e) => e.event)).toEqual(expect.arrayContaining(['ready_marked', 'branch_updated', 'ci_green', 'merged']));
  });
});

describe('Defect B — stale head after update-branch', () => {
  it('update-branch moves the head: not SUPERSEDED; prior CI invalidated, CI waited on the new sha, merge pinned to it', () => {
    const s = sim({ ciNew: 'pass', ci: { aaaa1111: 'pass' } });
    const r = train(s, ['778']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('#778 MERGED');
    expect(r.out).not.toContain('SUPERSEDED');
    expect(s.calls()).toEqual(['update aaaa1111', 'checks aaaa1111-u', 'merge aaaa1111-u']);
    const upd = events(s.ledger).find((e) => e.event === 'branch_updated');
    expect(upd?.head).toBe('aaaa1111-u');
    expect(upd?.detail).toContain('aaaa1111');
  });

  it('a green CI result for the obsolete (pre-update) sha is never reused: the new head stays pending → TIMEOUT HOLD, no merge', () => {
    const s = sim({ ci: { aaaa1111: 'pass' } });
    const r = train(s, ['778'], [], { MT_CI_TIMEOUT_S: '90', MT_CI_POLL_S: '45' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('TIMEOUT');
    expect(s.calls().filter((c) => c.startsWith('checks'))).not.toContain('checks aaaa1111');
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('a head pushed by someone else during the CI wait: SUPERSEDED, no merge', () => {
    const s = sim({ behind: false });
    const r = train(s, ['778'], [], { MT_CHECKS: `echo "checks $6" >> ${s.S}/calls; echo bbbb2222 > ${s.S}/head; echo pending` });
    expect(r.status).toBe(5);
    expect(r.out).toContain('SUPERSEDED');
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('base moves during validation: the branch is updated again, CI re-waited on the newest head, merged once on that head', () => {
    const s = sim({ ciNew: 'pass' });
    const f = path.join(s.S, 'mainsha');
    // main moves once after the first CI wait; the PR is behind again → second update-branch
    const r = train(s, ['778'], [], { MT_MAIN_SHA: `${counter(f, 'main-1', 'main-2')}; [ "$(cat ${f})" = 2 ] && touch ${s.S}/behind; true` });
    expect(r.status).toBe(0);
    expect(r.out).toContain('main moved');
    expect(s.calls()).toEqual(['update aaaa1111', 'checks aaaa1111-u', 'update aaaa1111-u', 'checks aaaa1111-u-u', 'merge aaaa1111-u-u']);
  });

  it('policy change between validation and merge: HOLD, no merge', () => {
    const s = sim({ draft: true, ciNew: 'pass' });
    const f = path.join(s.S, 'pol');
    const r = train(s, ['778'], ['--mark-ready'], { MT_POLICY: counter(f, 'READY', 'POLICY_BLOCKED') });
    expect(r.status).toBe(7);
    expect(r.out).toContain('POLICY_BLOCKED');
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });
});

describe('Defect C — bounded CI wait', () => {
  it('CI that never completes: explicit TIMEOUT → HOLD (exit 7), durable timeout entry, never approved', () => {
    const s = sim();
    const r = train(s, ['778'], [], { MT_CI_TIMEOUT_S: '90', MT_CI_POLL_S: '45' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('TIMEOUT');
    expect(s.calls().filter((c) => c.startsWith('checks'))).toHaveLength(3); // t=0, 45, 90
    expect(events(s.ledger).map((e) => e.event)).toEqual(expect.arrayContaining(['ci_wait', 'timeout', 'hold']));
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('SIGTERM during the CI wait: cancelled is recorded, the claim is released, nothing is merged', async () => {
    const s = sim();
    const c = spawn('bash', [script, 'run', path.join(s.S, 'log'), '778'], { cwd: s.dir, env: { ...process.env, ...s.env, MT_SLEEP: 'sleep 0.2', MT_CI_TIMEOUT_S: '3600' } });
    const done = new Promise<number | null>((resolve) => c.on('close', (code) => resolve(code)));
    for (let i = 0; i < 100 && !read(s.ledger).includes('"event":"ci_wait"'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(read(s.ledger)).toContain('"event":"ci_wait"');
    c.kill('SIGTERM');
    const code = await done;
    expect(code).not.toBe(0);
    expect(events(s.ledger).map((e) => e.event)).toContain('cancelled');
    expect(fs.readdirSync(path.join(path.dirname(s.ledger), 'merge-train.claims'))).toEqual([]);
    expect(s.calls().some((x) => x.startsWith('merge'))).toBe(false);
  }, 30_000);
});

// a stub gh on PATH: logs argv, serves GET fixtures (file name = API path with /?&= → _), refuses anything else
function stubGh(fixtures: Record<string, unknown> = {}, special = '') {
  const bin = tmp('mtc-bin-'); const fix = tmp('mtc-fix-'); const log = path.join(bin, 'gh.log');
  for (const [p, body] of Object.entries(fixtures)) fs.writeFileSync(path.join(fix, `${p.replace(/[/?&=]/g, '_')}.json`), JSON.stringify(body));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${log}
${special}
if [ "$1" = api ]; then
  shift; p=""; q=""
  while [ $# -gt 0 ]; do case "$1" in -q|--jq) q="$2"; shift 2 ;; -*) shift ;; *) p="$1"; shift ;; esac; done
  f="${fix}/$(printf '%s' "$p" | tr '/?&=' '____').json"
  [ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  if [ -n "$q" ]; then jq -r "$q" "$f"; else cat "$f"; fi
  exit 0
fi
echo "stub gh: unsupported $*" >&2; exit 2
`, { mode: 0o755 });
  return { bin, log, PATH: `${bin}:${process.env.PATH}` };
}

describe('failure modes', () => {
  it('concurrent attempt: an existing live claim makes the worker exit 6 without any GitHub mutation', () => {
    const s = sim({ ciNew: 'pass' });
    const pid = sh(s.dir, `git patch-id --stable < ${s.diff}`).stdout.split(' ')[0];
    const key = crypto.createHash('sha256').update(`djimit/djimitflo|778|${pid}`).digest('hex');
    const claim = path.join(path.dirname(s.ledger), 'merge-train.claims', key);
    fs.mkdirSync(claim, { recursive: true }); write(claim, 'owner', `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
    const r = train(s, ['778']);
    expect(r.status).toBe(6);
    expect(s.calls()).toEqual([]);
  });

  it('merge conflict on update-branch: exit 2, no merge', () => {
    const s = sim();
    const r = train(s, ['778'], [], { MT_UPDATE: `echo "update $6" >> ${s.S}/calls; echo 'gh: merge conflict between base and head (HTTP 422)' >&2; exit 1` });
    expect(r.status).toBe(2);
    expect(r.out).toContain('CONFLICT');
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('GitHub API timeout (gh hangs): the call is bounded, live state is unknown → HOLD, no mutation', () => {
    const s = sim();
    const gh = stubGh({}, 'exec sleep 30');
    const r = train(s, ['778'], [], { PATH: gh.PATH, MT_GH_TIMEOUT_S: '2', MT_PR_VIEW: '' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('HOLD');
    expect(s.calls()).toEqual([]);
  });

  it('network interruption after update-branch (live re-read fails): HOLD, no merge', () => {
    const s = sim({ ciNew: 'pass' });
    const r = train(s, ['778'], [], { MT_PR_VIEW: `if [ -f ${s.S}/calls ]; then echo 'connection reset by peer' >&2; exit 1; fi; echo "$(cat ${s.S}/state) $(cat ${s.S}/head) $(cat ${s.S}/draft)"` });
    expect(r.status).toBe(7);
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('worker restart mid-operation: the job queued for the pre-update head resumes from the ledger and merges the new head', () => {
    const s = sim({ ciNew: 'pass' });
    const crashed = train(s, ['778@aaaa1111'], [], { MT_CHECKS: 'kill -9 $$' });
    expect(crashed.status).not.toBe(0);
    expect(read(s.ledger)).toContain('"event":"branch_updated"');
    const replay = train(s, ['778@aaaa1111']);
    expect(replay.status).toBe(0);
    expect(replay.out).toContain('RESUME');
    expect(s.calls().filter((c) => c.startsWith('merge'))).toEqual(['merge aaaa1111-u']);
  });

  it('duplicate execution of the same intent: merged once, the duplicate is SATISFIED', () => {
    const s = sim({ ciNew: 'pass' });
    const r = train(s, ['778', '778']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('SATISFIED');
    expect(s.calls().filter((c) => c.startsWith('merge'))).toHaveLength(1);
  });

  it('ledger write failure fails closed before any mutation', () => {
    const s = sim({ ciNew: 'pass' });
    write(path.dirname(s.ledger), path.basename(s.ledger), ''); fs.chmodSync(s.ledger, 0o444);
    const r = train(s, ['778']);
    expect(r.status).toBe(8);
    expect(r.out).toContain('LEDGER');
    expect(s.calls()).toEqual([]);
  });

  it('ledger becomes unwritable mid-operation: stops before the next mutation (no merge)', () => {
    const s = sim({ ciNew: 'pass' });
    const r = train(s, ['778'], [], { MT_UPDATE: `echo "update $6" >> ${s.S}/calls; chmod 444 ${s.ledger}; echo "$(cat ${s.S}/head)-u" > ${s.S}/head; echo '{"message":"Updating pull request branch."}'` });
    expect(r.status).toBe(8);
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('partially completed operation (marked ready earlier, not merged): a plain rerun continues without --mark-ready', () => {
    const s = sim({ draft: false, ciNew: 'pass' });
    fs.mkdirSync(path.dirname(s.ledger), { recursive: true });
    write(path.dirname(s.ledger), path.basename(s.ledger), `{"at":"t","event":"ready_marked","pr":"778","head":"aaaa1111","key":"k","detail":""}\n`);
    const r = train(s, ['778']);
    expect(r.status).toBe(0);
    expect(s.calls()).toEqual(['update aaaa1111', 'checks aaaa1111-u', 'merge aaaa1111-u']);
  });

  it('required check missing on the head (real checks path, stub gh): never green → TIMEOUT HOLD', () => {
    const s = sim({ behind: false });
    const gh = stubGh({
      'repos/djimit/djimitflo/commits/aaaa1111/check-runs?per_page=100': { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
      'repos/djimit/djimitflo/commits/aaaa1111/status': { state: 'success', total_count: 0, statuses: [] },
    });
    const r = train(s, ['778'], [], { PATH: gh.PATH, MT_CHECKS: '', MT_REQUIRED_CHECKS: 'build,security-scan', MT_CI_TIMEOUT_S: '90', MT_CI_POLL_S: '45' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('security-scan');
    expect(s.calls().some((c) => c.startsWith('merge'))).toBe(false);
  });
});

// No false green (10-26): every REQUIRED context needs a success on the exact sha, the newest run per name decides, and
// unreadable branch protection is HOLD — never a remembered list.
describe('checks_verdict — no false green', () => {
  const C = 'repos/djimit/djimitflo/commits/s1';
  const verdict = (runs: unknown[], o: { statuses?: unknown[]; required?: string | null; protection?: unknown; summary?: unknown } = {}) => {
    const f: Record<string, unknown> = { [`${C}/check-runs?per_page=100`]: { check_runs: runs }, [`${C}/status`]: { state: 'success', statuses: o.statuses ?? [] } };
    if (o.protection !== undefined) f['repos/djimit/djimitflo/branches/main/protection/required_status_checks'] = o.protection;
    if (o.summary !== undefined) f['repos/djimit/djimitflo/branches/main'] = o.summary;
    const gh = stubGh(f);
    const req = o.required === undefined ? 'build,sbom' : o.required;
    const r = spawnSync('bash', ['-c', `source ${script}; checks_verdict s1; echo; mt_gh pr checks-at 1 --sha s1`], { encoding: 'utf8',
      env: { ...process.env, PATH: gh.PATH, MT_LEDGER: path.join(tmp('mtc-led-'), 'l'), MT_REQUIRED_CHECKS: req ?? '' } });
    const [json, line] = r.stdout.split('\n').filter(Boolean);
    return { ...(JSON.parse(json) as { verdict: string; red: string[]; reason?: string }), line };
  };
  const ok = (name: string, id = 1) => ({ id, name, status: 'completed', conclusion: 'success', completed_at: `2026-10-26T0${id}:00:00Z` });
  const done = (name: string, conclusion: string, id = 1) => ({ ...ok(name, id), conclusion });

  it('all required success: green (control)', () => {
    expect(verdict([ok('build'), ok('sbom')]).verdict).toBe('green');
  });
  for (const c of ['skipped', 'neutral', 'cancelled', 'stale']) {
    it(`a required check with ${c} is not green: red required_not_success`, () => {
      const v = verdict([ok('build'), done('sbom', c)]);
      expect(v.verdict).toBe('red');
      expect(v.reason).toBe(`required_not_success:sbom=${c}`);
      expect(v.line).toMatch(/^fail red:sbom/);
    });
  }
  it('a newer red run next to an older green run of the same name is red (newest per name decides)', () => {
    expect(verdict([ok('build', 1), ok('sbom', 2), done('sbom', 'failure', 3)]).verdict).toBe('red');
    // newer green rerun of an older red run: green — the rerun replaced it
    expect(verdict([ok('build', 1), done('sbom', 'failure', 2), ok('sbom', 3)]).verdict).toBe('green');
    // newer skipped next to older success: not green
    expect(verdict([ok('build', 1), ok('sbom', 2), done('sbom', 'skipped', 3)]).verdict).toBe('red');
  });
  it('a required check still running is pending, not red', () => {
    expect(verdict([ok('build'), { id: 2, name: 'sbom', status: 'in_progress', conclusion: null, completed_at: null }]).verdict).toBe('pending');
  });
  it('a non-required skipped or neutral check is still fine', () => {
    expect(verdict([ok('build'), ok('sbom'), done('docs', 'skipped', 2), done('lint-optional', 'neutral', 3)]).verdict).toBe('green');
    // a non-required failure stays red
    expect(verdict([ok('build'), ok('sbom'), done('docs', 'failure', 2)]).verdict).toBe('red');
  });
  it('unreadable branch protection without MT_REQUIRED_CHECKS: HOLD (pending required_checks_unavailable), never the old default list', () => {
    const v = verdict([ok('build'), ok('sbom')], { required: null });
    expect(v.verdict).toBe('pending');
    expect(v.reason).toBe('required_checks_unavailable');
    expect(v.line).toContain('required_checks_unavailable');
    const r = spawnSync('bash', ['-c', `source ${script}; required_json`], { encoding: 'utf8',
      env: { ...process.env, PATH: stubGh().PATH, MT_LEDGER: path.join(tmp('mtc-led-'), 'l'), MT_REQUIRED_CHECKS: '' } });
    expect(JSON.parse(r.stdout)).toEqual({ source: 'unavailable', contexts: [] });
  });
  it('readable branch protection is the source of the required contexts', () => {
    const v = verdict([ok('build'), done('gitleaks', 'skipped', 2)], { required: null, protection: { contexts: ['build'], checks: [{ context: 'gitleaks' }] } });
    expect(v).toMatchObject({ verdict: 'red', reason: 'required_not_success:gitleaks=skipped' });
    // protection endpoint unreadable (no admin read): the branch summary's protection block is the same live source
    const summary = { protection: { enabled: true, required_status_checks: { contexts: ['build', 'gitleaks'] } } };
    expect(verdict([ok('build'), ok('gitleaks', 2)], { required: null, summary }).verdict).toBe('green');
    expect(verdict([ok('build')], { required: null, summary }).verdict).toBe('pending');
    // a branch without protection: unavailable, not "no required checks"
    expect(verdict([ok('build')], { required: null, summary: { protection: { enabled: false, required_status_checks: { contexts: [] } } } }).reason).toBe('required_checks_unavailable');
  });
});

describe('--dry-run (read-only plan)', () => {
  const R = 'repos/o/r';
  // pick PR numbers: non-audit-sample ones for normal cases, one audit sample
  const normal: number[] = []; let audit = 0;
  for (let n = 900; normal.length < 12 || !audit; n++) { if (isAuditSample(n)) { if (!audit) audit = n; } else if (normal.length < 12) normal.push(n); }
  const [READY, ASSERT, GAP, RED, MISSING, CONFLICT, UNK, NONTEST, NOENTRY, CHANGES, NONLOOP, READY2] = normal;
  const testFile = [{ filename: 'packages/server/src/__tests__/a.test.ts', status: 'added', additions: 20, deletions: 0 }];
  const green = { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'security-scan', status: 'completed', conclusion: 'success' }] };
  function fixtures() {
    const f: Record<string, unknown> = {};
    const list: unknown[] = [];
    const pr = (n: number, o: { title?: string; ref?: string; draft?: boolean; mergeable?: boolean | null; ms?: string; labels?: string[];
      files?: unknown[]; reviews?: unknown[]; runs?: unknown } = {}) => {
      const p = { number: n, state: 'open', title: o.title ?? `loop: improve ${n}`, draft: o.draft ?? true, mergeable: o.mergeable === undefined ? true : o.mergeable,
        mergeable_state: o.ms ?? 'behind', user: { login: 'djimit-bot' }, labels: (o.labels ?? []).map((name) => ({ name })),
        head: { sha: `sha${n}`, ref: o.ref ?? `agent/maker-${n}`, repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'base0' } };
      list.push({ ...p, mergeable: undefined });
      f[`${R}/pulls/${n}`] = p;
      f[`${R}/pulls/${n}/files?per_page=100&page=1`] = o.files ?? testFile;
      f[`${R}/pulls/${n}/reviews?per_page=100`] = o.reviews ?? [];
      f[`${R}/commits/sha${n}/check-runs?per_page=100`] = o.runs ?? green;
      f[`${R}/commits/sha${n}/status`] = { state: 'pending', total_count: 0, statuses: [] };
    };
    pr(READY); pr(READY2, { draft: false, ms: 'clean' }); pr(ASSERT); pr(GAP, { labels: ['gap-orphan'] });
    pr(RED, { runs: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'security-scan', status: 'completed', conclusion: 'failure' }] } });
    pr(MISSING, { runs: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } });
    pr(CONFLICT, { mergeable: false, ms: 'dirty' }); pr(UNK, { mergeable: null, ms: 'unknown' });
    pr(NONTEST, { files: [{ filename: 'packages/server/src/services/x.ts', status: 'modified', additions: 3, deletions: 1 }] });
    pr(NOENTRY); pr(CHANGES, { reviews: [{ user: { login: 'op' }, state: 'CHANGES_REQUESTED' }] }); pr(audit);
    pr(NONLOOP, { title: 'feat: human change', ref: 'feat/human' });
    f[`${R}/pulls?state=open&per_page=100&page=1`] = list;
    f[`${R}/branches/main`] = { commit: { sha: 'main000' } };
    f[`${R}/branches/main/protection/required_status_checks`] = { contexts: ['build', 'security-scan'] };
    return f;
  }
  const assertions = () => {
    const prs: Record<string, unknown> = {};
    for (const n of [READY, READY2, RED, MISSING, CONFLICT, UNK, NONTEST, CHANGES, audit]) prs[n] = { assertion_strength: 'pass', run_verified: true };
    prs[ASSERT] = { assertion_strength: 'missing', run_verified: true };
    const file = path.join(tmp('mtc-as-'), 'assertions.json');
    fs.writeFileSync(file, JSON.stringify({ source: 'test fixture', prs }));
    return file;
  };
  const dry = (extra: Record<string, string> = {}) => {
    const gh = stubGh(fixtures());
    const out = path.join(tmp('mtc-out-'), 'plan.json'); const touched = path.join(tmp('mtc-t-'), 'mutated');
    const refused = path.join(tmp('mtc-r-'), 'refused');
    const r = spawnSync('bash', [script, '--dry-run', '--assertions', assertions(), '--out', out], { cwd: tmp('mtc-cwd-'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PATH: gh.PATH, MERGE_TRAIN_REPO: 'o/r', MT_LEDGER: path.join(tmp('mtc-led-'), 'l'), MT_REFUSED_LOG: refused,
        // even with every mutating probe overridden, the dry-run path never reaches them
        MT_MERGE: `touch ${touched}`, MT_UPDATE: `touch ${touched}`, MT_READY: `touch ${touched}`, MT_PUSH: `touch ${touched}`, ...extra } });
    return { ...r, out: `${r.stdout}${r.stderr}`, plan: fs.existsSync(out) ? JSON.parse(read(out)) : null, gh, touched, refused };
  };

  it('classifies every open loop PR (non-loop PRs excluded) with READY only when every rule passes on the current head', () => {
    const r = dry();
    expect(r.status).toBe(0);
    const by = Object.fromEntries((r.plan.prs as Array<{ number: number; primary: string }>).map((p) => [p.number, p.primary]));
    expect(by[NONLOOP]).toBeUndefined();
    expect(by).toMatchObject({ [READY]: 'READY', [READY2]: 'READY', [ASSERT]: 'ASSERTION_BLOCKED', [GAP]: 'GAP_ORPHAN', [RED]: 'CI_BLOCKED',
      [MISSING]: 'CI_BLOCKED', [CONFLICT]: 'CONFLICTED', [UNK]: 'UNKNOWN', [NONTEST]: 'POLICY_BLOCKED', [NOENTRY]: 'ASSERTION_BLOCKED',
      [CHANGES]: 'POLICY_BLOCKED', [audit]: 'POLICY_BLOCKED' });
    expect(r.plan.ready).toEqual([READY, READY2].sort((a, b) => a - b));
    expect(r.plan.counts.READY).toBe(2);
    const ready = (r.plan.prs as Array<{ number: number; transitions: string[]; secondary: string[] }>).find((p) => p.number === READY)!;
    expect(ready.transitions).toEqual(['mark_ready', 'update_branch', 'ci_on_new_head', 'squash_merge_at_head']);
    const missing = (r.plan.prs as Array<{ number: number; secondary: string[]; blockers: string[] }>).find((p) => p.number === MISSING)!;
    expect(missing.blockers.join(' ')).toContain('security-scan');
    expect(r.out).toContain('READY');
  });

  it('is read-only by construction: zero mutating gh invocations, no mutating probe reached, no ledger write', () => {
    const r = dry();
    expect(r.status).toBe(0);
    const calls = lines(r.gh.log);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).toMatch(/^api repos\/o\/r\//);
      expect(c).not.toMatch(/(^| )(-X|--method|-f|-F|--field|--raw-field|--input)( |=|$)/);
    }
    expect(fs.existsSync(r.touched)).toBe(false);
    expect(lines(r.refused)).toEqual([]);
    expect(r.plan.read_only).toBe(true);
    expect(r.plan.gh_calls.mutating).toBe(0);
  });

  it('the guard refuses mutating gh commands in read-only mode before gh runs', () => {
    const gh = stubGh({ 'repos/o/r/x': { ok: 1 } });
    const r = spawnSync('bash', ['-c', `source ${script}; READONLY=1
      for c in "pr merge 1" "pr ready 1" "pr edit 1" "pr update-branch 1" "pr comment 1" "api -X PUT repos/o/r/pulls/1/merge" "api repos/o/r/pulls/1/merge -f sha=x" "api graphql -f query=x" "run rerun 1" "label create x"; do
        ghx $c >/dev/null 2>&1 && echo rc=0 || echo "rc=$?"; done; ghx api repos/o/r/x`], { encoding: 'utf8', env: { ...process.env, PATH: gh.PATH, MT_LEDGER: path.join(tmp('mtc-led-'), 'l') } });
    const rcs = r.stdout.split('\n').filter((l) => l.startsWith('rc='));
    expect(rcs).toHaveLength(10);
    expect(new Set(rcs)).toEqual(new Set(['rc=99']));
    expect(r.stdout).toContain('"ok":1');
    expect(lines(gh.log)).toEqual(['api repos/o/r/x']);
  });
});
