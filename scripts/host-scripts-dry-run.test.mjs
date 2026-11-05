// Dry-run-by-default guard for host-mutating shell scripts (AGENTS.md "Host scripts and skills").
// Incidents behind it: an `lxc list` probe auto-installed the LXD snap on two hosts; a script run with a flag it did not
// have did a real sync. Convention: a script that mutates a host or remote system defaults to a dry run that prints what
// it would do and changes nothing, acts only with an explicit `--apply`, and an unknown flag exits non-zero.
// Every script runs in a throwaway sandbox with ssh/git/gh/docker/curl/... stubbed to record calls; nothing real runs.
// Run: node scripts/host-scripts-dry-run.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);

// Checked. `dryRun`: args of the default run (default none). `setup(sandboxRoot)` returns extra env.
// `noDryRunDefault` / `looseFlags`: a known gap, reported as a todo with its reason — each needs its own change.
const MUTATING = {
  'scripts/vps-runtime-cleanup.sh': {
    setup: (root) => {
      for (let i = 0; i < 8; i++) fs.mkdirSync(path.join(root, `runtime-source-${i}`));
      fs.writeFileSync(path.join(root, 'compose.yml'), `- ${root}/runtime-source-0:/workspace/djimitflo\n`);
      fs.mkdirSync(path.join(root, 'data/backups'), { recursive: true });
      for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `data/backups/b${i}.sqlite`), '');
      return { DJIMITFLO_ROOT: root };
    },
  },
  'scripts/install-deploy-script.sh': {
    dryRun: [SHA],
    setup: (root) => ({ DEPLOY_ROOT: root, AUTO_DEPLOY_INSTALL_DIR: path.join(root, 'lib/djimitflo') }),
  },
  'scripts/deploy-vps.sh': {
    dryRun: [SHA],
    looseFlags: 'an unknown 2nd/3rd arg falls to the dry run, or past --apply to a real deploy; any edit pauses auto-deploy until the host copy is reinstalled (DEP-01) — needs its own change',
  },
  'scripts/wiki-delta-emitter.sh': {
    noDryRunDefault: 'its timer/cron runs it without flags and must publish; flipping to --apply needs the installed unit changed with it — needs its own change',
  },
  'scripts/dependabot-merge.sh': {
    noDryRunDefault: 'CI entrypoint (dependabot-auto-merge.yml) that must merge on green; a --apply gate needs a workflow change',
  },
  'scripts/merge-train.sh': {
    noDryRunDefault: 'explicit-verb CLI: `run` mutates, no verb prints usage (exit 64), `--dry-run` is GET-only by construction (merge-train.test.ts)',
  },
};

// Match a mutating pattern but are not checked above.
const EXEMPT = {
  'scripts/auto-deploy.sh': 'systemd timer entrypoint (scripts/systemd/) that must act; gated by kill switch and checks, covered by auto-deploy.test.ts',
  'scripts/maker-uid-probe.sh': 'operator verification: one throwaway container (--rm, --network none, no volumes, removed on exit) from an existing image; changes nothing persistent (#1162)',
  'scripts/nightly-retention.sh': 'read-only: docker exec opens /data/djimitflo.sqlite readonly and prints counts (#1094 replaced the host DELETE)',
  'scripts/uams.sh': 'read-only: ssh runs curl health/search/stats queries against UAMS, no remote writes',
  'scripts/uams-tunnel.sh': 'read-only: a local ssh -L port forward and health curls, no remote writes; default verb is status',
  'scripts/scan-container.sh': 'read-only: docker inspect and trivy image scans; `brew install trivy` is only printed advice',
  'scripts/deploy-vps.selftest.sh': 'test helper',
  'scripts/vps-runtime-cleanup.selftest.sh': 'test helper',
  'scripts/wiki-delta-emitter.selftest.sh': 'test helper',
};

// Static: code (comments stripped) that writes to a host or remote system.
const MUTATING_PATTERNS = [
  /\b(ssh|scp|rsync|crontab|lxc|snap)\s/,
  /\bsystemctl\s+(--user\s+)?(enable|disable|start|stop|restart|reload|daemon-reload)\b/,
  /\bdocker\s+(run|compose|rm|rmi|build|stop|restart|pull|push|cp|exec)\b/,
  /\b(apt|apt-get|brew)\s+install\b|\bnpm\s+(i|install)\s.*-g\b|\bpip3?\s+install\b/,
  /\bghx?\s+(api\b.*(-X|--method)\s*(PUT|POST|PATCH|DELETE)|pr\s+(merge|ready|edit|close|create|update-branch))\b/,
  /\bgit\s+push\b/,
  /-X\s*(POST|PUT|PATCH|DELETE)\b/,
  /\/(srv|usr\/local)\//,
];

// Dynamic: a recorded stub call that would have changed something.
const STUBS = ['ssh', 'scp', 'rsync', 'systemctl', 'sudo', 'crontab', 'lxc', 'snap', 'apt', 'apt-get', 'brew', 'pip', 'pip3', 'npm', 'docker', 'gh', 'git', 'curl'];
const MUTATING_CALL = [
  /^(ssh|scp|rsync|systemctl|sudo|crontab|lxc|snap|apt|apt-get|brew|pip|pip3)\b/,
  /^npm (i|install)\b/,
  /^docker (run|compose|rm|rmi|build|stop|start|restart|pull|push|cp|exec)\b/,
  /^gh (api .*(-X|--method) ?(PUT|POST|PATCH|DELETE)|pr (merge|ready|edit|close|create|update-branch)|release|repo)\b/,
  /^git (push|commit|reset|checkout|switch|merge|rebase|cherry-pick|tag|clone|fetch)\b/,
  /^curl .*(-X ?(POST|PUT|PATCH|DELETE)|(^| )(-d|--data\S*|-T|--upload-file|-F)( |$))/,
];

function sandbox() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'host-dry-run-'));
  for (const d of ['bin', 'tmp', 'home', 'root']) fs.mkdirSync(path.join(sb, d));
  for (const name of STUBS) {
    // records the call; curl -o FILE gets a parseable empty script (install-deploy-script.sh runs bash -n on it)
    fs.writeFileSync(path.join(sb, 'bin', name), `#!/bin/sh
echo "${name} $*" >> "$STUB_LOG"
prev=; for a; do [ "$prev" = "-o" ] && printf '#!/bin/sh\\n' > "$a"; prev="$a"; done
exit 0
`, { mode: 0o755 });
  }
  return sb;
}

const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
  const st = fs.statSync(path.join(dir, f));
  return `${f} ${st.isDirectory() ? 'dir' : st.size}`;
});

function run(script, args) {
  const spec = MUTATING[script];
  const sb = sandbox();
  const root = path.join(sb, 'root');
  const log = path.join(sb, 'calls.log');
  const extra = spec.setup ? spec.setup(root) : {};
  const before = [snapshot(root), snapshot(path.join(sb, 'home'))];
  const r = spawnSync('bash', [path.join(ROOT, script), ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: `${path.join(sb, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(sb, 'home'), TMPDIR: path.join(sb, 'tmp'), STUB_LOG: log, ...extra },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const unchanged = JSON.stringify(before) === JSON.stringify([snapshot(root), snapshot(path.join(sb, 'home'))]);
  fs.rmSync(sb, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, mutating: calls.filter((c) => MUTATING_CALL.some((re) => re.test(c))), unchanged };
}

for (const [script, spec] of Object.entries(MUTATING)) {
  const dryRun = spec.dryRun ?? [];
  if (spec.noDryRunDefault) test(`${script}: defaults to a dry run`, { todo: spec.noDryRunDefault });
  else {
    test(`${script}: no args changes nothing`, () => {
      const r = run(script, []);
      assert.deepEqual(r.mutating, [], r.out);
      assert.ok(r.unchanged, `no args touched files\n${r.out}`);
    });
    test(`${script} ${dryRun.join(' ')}: a dry run that prints what it would do`, () => {
      const r = run(script, dryRun);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /dry[ -]run/i);
      assert.deepEqual(r.mutating, [], r.out);
      assert.ok(r.unchanged, `the dry run touched files\n${r.out}`);
    });
  }
  if (spec.looseFlags) test(`${script}: an unknown flag fails`, { todo: spec.looseFlags });
  else {
    test(`${script}: an unknown flag fails and changes nothing`, () => {
      const r = run(script, [...dryRun, '--no-such-flag']);
      assert.notEqual(r.status, 0, r.out);
      assert.deepEqual(r.mutating, [], r.out);
      assert.ok(r.unchanged, `the unknown flag touched files\n${r.out}`);
    });
  }
}

test('every shell script that matches a mutating pattern is checked or exempt with a reason', () => {
  const files = ['scripts', 'infra'].flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => path.join(d, f)) : []))
    .filter((f) => f.endsWith('.sh'));
  const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const unlisted = files.filter((f) => !(f in MUTATING) && !(f in EXEMPT) && MUTATING_PATTERNS.some((re) => re.test(code(f))));
  assert.deepEqual(unlisted, [], 'add each to MUTATING (default dry run, --apply to act) or to EXEMPT with a one-line reason');
  for (const f of [...Object.keys(MUTATING), ...Object.keys(EXEMPT)]) assert.ok(files.includes(f), `${f} is listed but does not exist`);
  for (const [f, reason] of Object.entries(EXEMPT)) assert.ok(reason.trim() && !(f in MUTATING), `${f}: exempt needs a reason and cannot also be checked`);
});
