# Design: maker uid separation (S0 step 1)

Status: step 1 implemented behind `MAKER_UID_SEPARATION` (default `off`). Builds on `docs/design/sandbox-runner.md`
(#950) use case 0. That design moves VPS maker execution out of `djimitflo-live` (V-C, workstation). This is the
in-container step that can go first: measure the separation per maker lease, refuse an unseparated maker when asked,
and prepare a second uid.

## Control

Maker CLIs (opencode, claude, codex, ...) spawned by the execution engine inside `djimitflo-live` must not be able to:

- write the control-plane DB (`DB_PATH`, `/data/djimitflo.sqlite`) or create files next to it, or
- read the server process's environment (`/proc/<server pid>/environ`).

The executor env allowlist (`executor-env.ts`) already keeps server secrets out of the child's own env. It cannot stop
a process running as the same uid from opening the DB or reading the server's environ, because both are guarded by
the uid. A different uid is the boundary.

## Modes

| Mode | What runs | Behaviour change |
|---|---|---|
| `off` (default) | nothing | none: spawn args, env and lease flow are unchanged (test: `maker-uid-separation.test.ts` compares the engine inputs for unset, `off` and `shadow`) |
| `shadow` | before every in-container maker lease (all runtimes but `remote`), one `/bin/sh` probe (`PROBE_SCRIPT`) spawned like the maker: the worktree as cwd, the same allowlisted executor env, the server as parent | none: lease metadata `uid_separation` = `{ uid, gid, db_exists, db_writable, db_readable, db_dir_writable, proc1_environ_readable, parent_environ_readable, separated, refused: false }`. `separated` is null when any answer is unknown (no `/proc`) |
| `on` | the same probe | a maker starts only when `separated === true`. Otherwise the lease fails at stage `prepare` (`maker_uid_separation_not_separated` / `_unknown` / `_probe_failed`) with loop event `maker_uid_separation_refused`. Fail closed |

Run-as-maker is **not** built in this step. So today `on` refuses every in-container maker. That is intended:
`on` never runs a maker it cannot show is separated. Route makers remote (`REMOTE_MAKER_ENABLED`) before setting it.

Image delta: one layer near the end of the runner stage reserves uid/gid 1002 `maker`: no home, shell `nologin`, not in
the `djimitflo` group. `USER djimitflo` (1001), the entrypoint, the env and every installed binary stay the same. Nothing
runs as 1002 while the flag is `off` or `shadow`. The layer sits after the install steps, so it invalidates no cached
install layer.

## Evidence

**VERIFIED (2026-11-05).** Run in a throwaway container from the prod image `djimitflo:main-c265730` on the VPS: no
network, no volumes, a canary `JWT_SECRET`, a fixture `/data/djimitflo.sqlite` (600, owned by 1001), and node as PID 1
running as 1001 (`scripts/maker-uid-probe.sh` plus two ad-hoc checks):

- The image ships `setpriv` and `runuser` (util-linux). It does not ship `setcap`.
- The uid 1001 process has `CapEff 0`, `CapBnd 00000000a80425fb` (Docker default, which includes SETUID, SETGID and KILL) and `NoNewPrivs 0`.
- As 1001, the DB is writable, `/data` is writable and `/proc/1/environ` is readable.
- As 1002, the DB is not writable or readable, `/data` is not writable, `/proc/1/environ` is not readable, and the canary is not readable.
  The cross-uid environ read is refused by the uid check alone. No `hidepid` and no dumpable change is needed, because there is no CAP_SYS_PTRACE.
- A plain `setpriv --reuid=1002` run by 1001 fails with `setresuid: Operation not permitted`, because CapEff is 0.
- A setuid-root copy of `setpriv` does switch 1001 to 1002, and leaves CapPrm and CapEff at 0 afterwards.
- 1001 cannot signal a 1002 process (`kill -TERM` gives EPERM).

**UNVERIFIED.**
- The live prod layout: the `/data` bind mount at 775, node as PID 1, and worktrees under `/data/loop-worktrees`. These come from the 11-05 audit. `shadow` measures them per lease.
- The fixed-target helper below. It is not built.
- Probe results for a 1002 process spawned by the server through that helper. Inference: the same uid check applies.

## Follow-up: run-as-maker (`on` that starts makers)

The findings above rule out the obvious paths:
- `setpriv` or `runuser` from the server cannot switch uid.
- A setuid `setpriv` would accept any target uid, including 0.
- The server could not stop a 1002 child: cancel, timeout and the group kill in `runtime-process.ts` would all fail with EPERM.

Steps, one PR each, each behind `MAKER_UID_SEPARATION=on`:

1. **Helper.** `run-as-maker` is about 80 lines of C, built in the builder stage (gcc is already there) and installed as
   `/usr/local/lib/djimitflo/run-as-maker`, root:djimitflo 4750. It takes no uid argument. The target is fixed at 1002.
   - **Child:** `setgroups(0)`, `setresgid(1002)`, `setresuid(1002)` (and checks that they stuck), `umask 007`, `setsid`,
     `prctl(PR_SET_PDEATHSIG, SIGKILL)`, then `execvp(argv[1])`.
   - **Parent:** sets `PR_SET_KEEPCAPS`, drops to 1001/1001/1001, `capset` keeps only CAP_KILL. It relays
     TERM/INT/HUP to the child's group, SIGKILLs that group when it exits, and exits with the child's status.
   - **Tests:** an image test runs `scripts/maker-uid-probe.sh` through the helper, plus cancel and timeout of a 1002 child.
   - **Trade-off:** this needs NoNewPrivs 0 on the container. Docker `no-new-privileges` (sandbox-runner P1 flags) would
     disable the helper. Decide that before turning it on.
2. **Spawn.** In `on`, `spawnRuntime` runs `helper [command, ...args]` for maker leases only. The probe goes through the same
   helper, so `separated` describes the real maker context. Unit test: argv construction for off, shadow and on. Off stays identical.
3. **Worktrees.**
   - Move `LOOP_WORKTREE_ROOT` out of `/data` to a `/work` volume, `djimitflo:maker 2770`. Add 1001 to group `maker`
     (not the reverse). Give the maker umask 007.
   - Pass `safe.directory` to both uids: the maker through `GIT_CONFIG_COUNT` in its env, the server through `git -c`.
   - Make the main repo's `.git/worktrees/<id>` group-writable for the maker's index writes.
   - Then set `/data` to 0700 (host: `chmod 700 /srv/djimitflo/data`).
4. **Runtime credentials.** Give the maker its own `HOME=/home/maker` (a volume, 700, owned by 1002) holding only what the
   maker runtimes need. Subscription OAuth makers (claude, codex) either get their own login there or stay remote.
5. **Checks.** Deterministic checks that execute maker-modified code (`npm ci`, tests, lint) go through the same helper.
   Otherwise they reopen the gap as 1001.
6. **Acceptance.**
   - `shadow` rows on prod show `uid: 1002, separated: true` for ≥ 20 consecutive in-container maker leases.
   - The maker completion rate is not lower than the 7 days before.
   - `scripts/maker-uid-probe.sh` passes on the deployed image.
   - Then the operator sets `on`.

## Operator steps for step 1

1. Deploy as usual. With the flag unset, nothing changes except the reserved `maker` user in the image.
2. On the VPS, run `bash scripts/maker-uid-probe.sh djimitflo:main-<sha>` against the deployed image. Expect `PASS`, exit 0.
3. Optional: set `MAKER_UID_SEPARATION=shadow` in `runtime.env` and recreate. Then read
   `SELECT id, json_extract(metadata,'$.uid_separation') FROM worker_leases WHERE role='maker' ORDER BY created_at DESC LIMIT 5`.
   Today's expected baseline is `uid 1001, separated false`. That is the gap, now recorded per lease.
4. Do not set `on` until the follow-up's step 6 is met. Until then it refuses every in-container maker.
