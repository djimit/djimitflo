# Design: sandbox runner for untrusted agent code

Status: design only, 2026-10-22. No code, no host changes. Implementation goes behind `SANDBOX_RUNNER_MODE` (default
`off`), one use case at a time, shadow before act. Every acting step is the operator's decision (section 14).

Evidence tags: **FACT** = observed on the host on 2026-10-22, or read in code at `origin/main` fc29222c, or in a cited
upstream source. **INFERENCE** = follows from facts, not yet tested. **UNKNOWN** = not established. An UNKNOWN is a test
in the rollout, never a pass.

## 1. Summary

- **What we have is weaker than assumed.** The workstation gym runner (`scripts/gym-worker.mjs` `runnerArgs`) runs
  agent-driven code with `--network host`. Under this rootless Docker setup (`--detach-netns`) that is the **real host
  network namespace**. The runner also has no resource caps, a writable rootfs and the default capabilities, and container
  root maps to the `djimit` uid. Afterwards the host runs `git` on the tree the agent could write to. On the VPS, makers
  and checks run inside `djimitflo-live` as the same uid that owns `/data/djimitflo.sqlite`. The hardened flag set we
  thought of as "current" exists only in `DockerSandboxExecutor` (VPS side), and the gym worker does not use it.
- **Recommendation: one runner and one job contract, with two isolation profiles.**
  - **P1 `runc-hardened`** needs no install and can start now. It uses rootless Docker with `--network none`, a non-root
    container uid (so it maps to an unprivileged subuid, not `djimit`), `--read-only`, `--cap-drop ALL`,
    `no-new-privileges`, cpu/memory/pids caps and tmpfs. Egress goes only through a host-side allowlist proxy reached
    over a bind-mounted Unix socket. Inputs are copied in, and only patch and logs come out. The host never runs `git`
    inside the agent's tree.
  - **P2 `gvisor`** needs the operator to install a pinned runsc release. It covers kernel-escape risk for external repos
    and community tools, and it is the most likely place for Codex's own bubblewrap sandbox to work. One blocker: runsc
    under *rootless* Docker is broken upstream (google/gvisor#12575 is open and fix PR #14578 is unmerged, checked
    2026-10-22). So P2 starts as runsc registered on the workstation's existing **rootful** daemon. The worker uid can
    already use that daemon (it is in the `docker` group), so this grants no new privilege. P2 moves to rootless once
    #14578 ships.
  - **Firecracker** is the later P3 option, only if gVisor fails our acceptance battery. It is feasible: `/dev/kvm` is
    present, but `djimit` is not in the `kvm` group. Its maintenance cost is the highest.
- **Use case 0 (VPS makers, checks and falsifier sharing the control plane's uid).** No fix inside the container is
  possible: CapEff is 0, so the container cannot switch uid, and the host blocks unprivileged user namespaces, so bwrap
  cannot run. The recommendation is to move this execution out of `djimitflo-live` through the existing pull model.
  The primary target is the workstation runner, which reuses `remote-maker-queue`. A sidecar sandbox worker on the VPS
  host is the fallback.
- **Codex subscription auth cannot be scoped per job.** This doc says so plainly (section 9.2): the options trade blast
  radius for cost. The recommended option is Codex's own sandbox inside P2, plus a dedicated account, a per-job copy of
  the auth file, output scrubbing and a hash check. The operator decides.

## 2. Scope and non-goals

In scope: a host-side runner on the workstation (and the same contract on the VPS host), the job contract, network,
secrets, resource, audit and cleanup policy, rollout, acceptance and rollback.

Not in scope (this PR): changes to `tg-001.ts`, `remote-gym-service.ts`, `scripts/gym-worker.mjs`, prod config, or any
host installation. The VPS never calls the workstation. Every step below keeps the pull model: the workstation claims
work from the VPS API, and nothing is pushed to it.

## 3. Host inspection (read-only, 2026-10-22)

Commands used: `uname`, `sysctl`, `cat /proc/...`, `docker info/inspect/ps/images`, `systemctl cat/list-units`,
`ip -br addr`, `ss -ltn`, `ls -l /dev/...`, `stat`. Nothing was written, started or stopped. One probe that would have
copied a script to the VPS and executed it inside `djimitflo-live` was refused by the session's permission classifier.
It was not attempted any other way, so in-container facts on the VPS come from host-side `/proc` and `docker inspect`
only.

### 3.1 Workstation (`djimit@100.81.133.48`)

| Item | Observed | Tag |
|---|---|---|
| OS / kernel | Ubuntu 24.04.5, Linux 7.0.0-38-generic x86_64, 48 cores, 125 GiB RAM, `/` 76 % used (106 GiB free) | FACT |
| Unprivileged userns | `kernel.unprivileged_userns_clone=1`, **`kernel.apparmor_restrict_unprivileged_userns=0`**, `apparmor_restrict_unprivileged_unconfined=0`, `user.max_user_namespaces=475710` | FACT |
| LSMs | `lockdown,capability,landlock,yama,apparmor,ima,evm`; yama ptrace_scope 1; `unprivileged_bpf_disabled=2` | FACT |
| AppArmor | enabled; `/etc/apparmor.d` present incl. `unprivileged_userns`, `rootlesskit`, `runc`, `crun`, `podman` profiles; **no bwrap profile** | FACT |
| Sandbox binaries | `bwrap` 0.9.0 (Ubuntu pkg 0.9.0-1ubuntu0.3), `runc` 1.5.1, `rootlesskit`, `unshare`, `newuidmap` present; **`runsc`, `firecracker`, `kata-runtime`, `crun`, `systemd-nspawn`, `slirp4netns`, `pasta`, nvidia-container-toolkit missing** | FACT |
| KVM | `/dev/kvm` `crw-rw---- root kvm`; CPU virt flags present; **`djimit` not in group `kvm`** | FACT |
| cgroups | v2 (`cgroup2fs`); root controllers `cpuset cpu io memory hugetlb pids rdma misc dmem`; **user delegation `cpu memory pids` only (no `io`)** | FACT |
| subuid/subgid | `djimit:100000:65536` both | FACT |
| Docker | Two daemons. Rootless (current context, `/run/user/1000/docker.sock`, 29.8.1, overlayfs, systemd cgroups, seccomp builtin, runtimes `runc` only), and **rootful** (`/var/run/docker.sock`, `root:docker 660`). | FACT |
| Rootless network | `rootlesskit --net=gvisor-tap-vsock --disable-host-loopback --port-driver=builtin --detach-netns` | FACT |
| `djimit` groups | `adm sudo lxd docker render video ollama plugdev …` → **docker + lxd membership is root-equivalent**; sudo needs a password or not: UNKNOWN | FACT / INFERENCE |
| Gym runner containers (2 running: `gym-workstation-*`, `mfr-001-*`) | `NetworkMode=host`, `ReadonlyRootfs=false`, CapDrop/CapAdd none, SecurityOpt none, Memory 0, PidsLimit none, NanoCpus 0 (8 cpus for mfr-001), User root, `AutoRemove=true`, runtime runc, label `djimitflo-gym-host=<host>` | FACT |
| Runner netns | runner pid's `ns/net` = `net:[4026531833]` = **the host's init netns**; userns differs (rootless) | FACT |
| Runner confinement | Uid 1000 on host (container root = `djimit`), CapEff `a80425fb` (Docker default set), Seccomp 2 (filter), AppArmor label `rootlesskit (unconfined)` → **no AppArmor confinement of containers** | FACT |
| Runner mounts | worktree `~/.djimitflo-gym/wt-*` → `/w` rw, state dir → `/state` rw, volume `djimitflo-gym-npm` → `/root/.npm` rw; no `$HOME`, no secrets, no docker socket | FACT |
| Image | `djimitflo-gym-runner:atomic-0.6.5` (sha256:b15ba19e…), built 2026-09-27 from `node:22-bookworm-slim` (tag, **not digest**), atomic-agent v0.6.5 tarball sha256-checked | FACT |
| Host listeners reachable from host netns | loopback: 3000/3001/4000/8083/**8084 (llama-router)**/8787/9090/…; all interfaces: **11434 (Ollama)**, 5432 (Postgres), 6333/6334 (Qdrant), 139/445 (SMB), 8000, 8088, 8080; tailnet IP: 3000, 4000 (LiteLLM), 443, 8711 | FACT |
| Host firewall | `djimit-edge.nft`: guarded ports 11434, 5432, 8007, 8080, 5678, 139, 445, 6333, 9119 accepted from `127.0.0.0/8, 192.168.1.0/24, 100.64.0.0/10, 172.16.0.0/12, 10.187.138.0/24`; input chain only, **no egress filtering** | FACT |
| Network reach | LAN `eno1 192.168.1.28/24`, gateway 192.168.1.1, `tailscale0 100.81.133.48`, NAS autofs at `/mnt/nas`, LXD bridge 10.187.138.0/24, many Docker bridges | FACT |
| GPUs | NVIDIA RTX 2060 SUPER 8 GiB (`/dev/nvidia*` **mode 666**), AMD R9700 for llama-router (`/dev/dri/renderD128/129`, group render); runner `Devices=[]` | FACT |
| Abstract Unix sockets in host netns | systemd bus (`@…/bus/systemd/bus-system`, `bus-api-user`, `logind`, `resolve`, `network`), multipathd, iscsiadm | FACT |
| Host secrets near the worker | `~/.djimit/{gym-worker.token, gym-worker-2060.token, host-agent.token, systemone.token, fleet-event.key}` and `~/.codex/auth.json`, all mode 600 `djimit` | FACT |
| Codex | `@openai/codex` 0.157.1 in `~/.npm-global` and `~/.local` (not on the non-login PATH); `auth.json` `auth_mode=chatgpt` with `id_token, access_token, refresh_token, account_id` and an `OPENAI_API_KEY` field (value not read) | FACT |
| Worker unit | `djimitflo-gym-worker.service` (user, oneshot, timer), `GYM_HOST=workstation`, token file `~/.djimit/gym-worker.token`, `TimeoutStartSec=3600`, `Nice=10` | FACT |
| git | 2.43.0 on host | FACT |

### 3.2 VPS (`vps-agentical`, 100.86.47.122): host-side reads only

| Item | Observed | Tag |
|---|---|---|
| Host | Ubuntu 24.04.5, Linux 6.8.0-146, **2 cores, 7 GiB** | FACT |
| Userns | `kernel.apparmor_restrict_unprivileged_userns=1`, `user.max_user_namespaces=31436` | FACT |
| Binaries | `runsc` missing, `bwrap` missing; rootful Docker, runtimes `runc` only, security options apparmor+seccomp+cgroupns | FACT |
| KVM | `/dev/kvm` present (`root:kvm`) | FACT |
| `djimitflo-live` | network `djimitflo_default` (`Internal=false`), rootfs writable, no caps added or dropped, no memory, cpu or pids limit, runtime runc, `User=djimitflo` | FACT |
| Process | Uid 1001, **CapEff 0**, Seccomp 2, AppArmor `docker-default (enforce)` | FACT |
| Mounts | `/srv/djimitflo/data → /data` rw (host dir **mode 777**, `djimitflo.sqlite` `1001:1001 600`); `codex-home → ~/.codex` rw (700, 1001); runtime source rw; knowledge rw; telegram-leases rw; **no docker socket mounted** | FACT |
| Docker CLI inside the image | not verified (in-container probe refused) | UNKNOWN |
| Makers/checks in the same uid, worktrees under `/data`, ~4 329 bash calls / 30 d | reported by #948 (`docs/research/mcp-a2a/SECURITY_GAPS.md` S0); not re-measured here | reported |

### 3.3 Upstream facts used

- gVisor rootless: `runsc --rootless` needs the host network (Netstack is not supported). Docker and Podman do the
  userns setup through rootlesskit. Source: gvisor.dev/docs/user_guide/rootless. **FACT**
- runsc under rootless Docker fails with `cannot read client sync file: waiting for sandbox to start: EOF`. The only
  workaround is `--TESTONLY-unsafe-nonroot`. google/gvisor#12575 is **open**, fix PR #14578 is **open and unmerged**
  (GitHub API, 2026-10-22). The latest release is `release-20261012.0`. **FACT**
- gVisor has a `runsc bwrap` personality, and its `--unshare-user` runs Sentry and Gofer rootless
  (gvisor.dev/docs/user_guide/personalities/bwrap). Which release first shipped it, and whether it works on this host:
  **UNKNOWN**.
- gVisor implements user namespaces in the Sentry and enforces `max_user_namespaces` so bwrap/flatpak can limit nesting
  (google/gvisor PRs #13539, #14951). **FACT**. That Codex's bwrap therefore works inside runsc: **INFERENCE**.
- The Codex Linux sandbox uses bubblewrap (system `bwrap` on PATH, else bundled), seccomp after fs isolation, and
  `--unshare-net` for restricted network. In managed-proxy mode it runs a TCP→UDS→TCP bridge, so tool traffic reaches only
  configured proxy endpoints. It needs unprivileged userns. Source: `openai/codex` `codex-rs/linux-sandbox/README.md`.
  **FACT**
- Codex's bwrap inside a default Docker container fails (default seccomp and AppArmor block userns creation). The known
  fixes are `SYS_ADMIN` + unconfined seccomp, a setuid bwrap, or `--dangerously-bypass-approvals-and-sandbox` with the
  container as the boundary (openai/codex issues; Ubuntu 24.04 write-ups). **FACT**. Our own VPS tests on 18-10 reproduced
  this (`Failed to make / slave`, then `loopback: Failed RTM_NEWADDR`).

## 4. Findings that change the baseline

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | The gym runner shares the host netns. | `runnerArgs` `--network host` (gym-worker.mjs:226); ns inode equal to host | Agent code can reach llama-router/Ollama (GPU), Postgres, Qdrant, SMB/NAS, the LAN, the tailnet (VPS API at 100.86.47.122:3001, LiteLLM), and host abstract sockets (systemd bus). |
| F2 | Container root = `djimit` on the host, and `djimit` is root-equivalent (docker + lxd groups). | `/proc/<pid>/status` Uid 1000; `id` | Any container escape, or any host-side code execution triggered by agent output, is effectively root on the workstation. |
| F3 | The host runs `git` in the agent-writable worktree after the maker. | gym-worker.mjs:295-296, 404, 413 (`git -C wt add -N`, `diff`, `ls-files`) | The agent can replace `/w/.git` (a file inside the rw mount) with a directory whose config sets `core.fsmonitor` or similar. Host `git` would then run that command as `djimit` (**INFERENCE**, standard git config attack; not exercised). Symlinks the agent plants are also read by host-side `fs.readFileSync` (line 407). |
| F4 | There are no resource caps. | HostConfig Memory 0, PidsLimit none | Fork or memory bombs hit a shared 48-core host that also serves llama-router and Ollama. |
| F5 | The rootless daemon gives containers no AppArmor confinement. | label `rootlesskit (unconfined)` | Seccomp plus the userns are the only layers. |
| F6 | runsc + rootless Docker is broken upstream today. | #12575 / #14578 | P2 cannot be "rootless Docker + runsc" yet. |
| F7 | VPS execution of agent code shares the control plane's uid, DB and network. | Uid 1001, CapEff 0, `/data` 777, DB 600 owned by 1001, network not internal | U0: a maker or test can read and write the production DB and reach anything the VPS reaches, including the tailnet (**INFERENCE** for tailnet routing). `outbound-guard.ts` covers Node `fetch` in the server only, not child processes (comment in file). |
| F8 | `DockerSandboxExecutor` already has the hardened flag set. | docker-sandbox-executor.ts:263-285 | Reuse its flag builder and tests for P1 instead of inventing a new one. |

## 5. Threat model

**Adversary.** Code we did not write runs with our compute: maker output, agent-submitted tests (#938), a third-party
reviewer binary (OCR, #942), external repos and their dependency lifecycle scripts, community tools. The adversary may
also be a model steered by prompt injection from repo content. We assume the adversary knows this design.

**Assets.**
- (A1) Host secrets: `~/.djimit/*.token`, `fleet-event.key`, `~/.codex/auth.json`, SSH keys, `~/.config`.
- (A2) The control plane: VPS API, DB, HMAC scopes.
- (A3) The LAN, NAS and tailnet (other hosts, Synology backups).
- (A4) Host integrity, meaning no persistence.
- (A5) Shared compute: GPUs via llama-router and Ollama, CPU and RAM, disk.
- (A6) The integrity of our verdicts: the gym and falsifier oracles. A sandbox that leaks lets an agent fake green.
- (A7) Subscription accounts: ChatGPT Pro, Claude Max.

| Threat | Vector | Must hold |
|---|---|---|
| T1 Secret exfiltration | read host files; read env; send them over the network or hide them in the patch or logs | No host secret is visible; no route out except the allowlist proxy; artefacts are scrubbed (exact-match the known secret values plus `redactSecrets`). |
| T2 Reach LAN, NAS, tailnet or the control plane | direct sockets; DNS rebinding through the proxy; abstract Unix sockets; IPv6 ULA | Netns with loopback only; the proxy resolves DNS itself and rejects private, CGNAT, link-local, loopback and ULA addresses after resolution; no abstract-socket sharing. |
| T3 Persist on the host | write outside the job dir; cron or systemd user units; git hooks or config the host later runs; poisoned caches (`djimitflo-gym-npm` volume) | rootfs read-only; the only writable places are tmpfs and the job volume, destroyed at the end; the host never runs tools inside the agent's tree; caches are read-only to the sandbox. |
| T4 Container or kernel escape | kernel syscall bug; runc bug; misconfigured mounts | P1: non-root subuid, no caps, seccomp, `no-new-privileges`. P2: gVisor Sentry, where host-kernel exposure is runsc's own seccomp list. An escape in P1 lands as an unmapped subuid, not `djimit`. |
| T5 Burn GPU or compute | call llama-router or Ollama directly; fork or memory bombs; endless runs; huge output | No direct route to model servers (only through the proxy, with request and token budgets); cgroup cpu, memory and pids limits; wall-clock kill; log and patch byte caps. |
| T6 Fake the verdict | edit tests, oracle or reporter; write the report file; tamper with timing | The oracle runs in a fresh sandbox from the trusted base plus the validated patch; reports are read from the export dir only after the run, as data; canaries (RX-11) stay. |
| T7 Supply chain of the sandbox itself | unpinned runsc, base image or Codex binary | Everything is pinned by digest or checksum held in this repo; runtime-admission records the versions. |
| T8 Account abuse | a subscription token used beyond the job | See 9.2. This threat is not fully closable for subscription auth. |

Out of scope: a malicious operator; hardware side channels (we accept the residual risk of shared CPU cache with gVisor
and runc; Firecracker reduces but does not remove it); attacks on OpenAI or Anthropic infrastructure.

## 6. Use cases and their needs

| ID | Use case | Code origin | Network need | Secret need | Typical cost |
|---|---|---|---|---|---|
| U0 | VPS prod makers, checkers, deterministic checks, falsifier runs | our agents + model output | model endpoint(s); npm registry for install | model key or subscription per runtime | ~4 329 bash calls / 30 d (#948) |
| U1 | Codex subscription gym species | Codex + model commands | `chatgpt.com` / OpenAI endpoints only | ChatGPT subscription auth (9.2) | ≤ 15 min per attempt |
| U2 | Commons falsifier allowlist (#938) | Commons agents' tests | **none** (tests run offline; deps pre-installed from the trusted lockfile) | none | ≤ 5 min, ≤ 5 / day |
| U3 | OCR trial (#942) | third-party binary, reviewed diff | one model provider endpoint | one provider key, scoped and capped | per item minutes, 86 items |
| U4 | External customer repos | unknown code + dependencies | registry during install; model during make; none during test | model credential only | varies |
| U5 | Community tool evaluation | unknown binaries | none by default; per-tool allowlist after review | none | short |

U2 needs no egress and no secret. That makes it the cleanest first real job on the runner, together with U0's
test and check steps. U0's maker step and U1 come second, because they need a model credential.

## 7. Options

Scores are per threat (section 5): ● strong, ◐ partial, ○ weak. The tag says how we know.

| | O1 rootless Docker + runc, hardened (P1) | O2a runsc on the **rootful** daemon (P2 start) | O2b runsc on rootless Docker | O2c runsc standalone (`runsc --rootless run` / `runsc bwrap --unshare-user`) | O3 bubblewrap on host + `systemd-run --user` scope | O4 Firecracker microVM | O4b Kata Containers | O5 systemd-nspawn |
|---|---|---|---|---|---|---|---|---|
| Present on host | yes (FACT) | daemon yes, runsc no (FACT) | runsc no | runsc no | bwrap 0.9.0 yes (FACT) | no binary; `/dev/kvm` yes, `djimit` not in `kvm` (FACT) | no (FACT) | no (FACT) |
| Works rootless | yes (FACT, runs today) | no: needs root to install and register; the worker can already use the daemon (FACT: docker group) | **no, broken upstream** (FACT #12575) | yes per docs, but host network only with `--rootless`, so `--network=none` is required (FACT docs; on this host UNKNOWN) | yes: restrict=0 (FACT), not tested | yes with `kvm` group and no jailer (INFERENCE); jailer needs root | no: needs rootful containerd + KVM (INFERENCE) | mostly root (INFERENCE) |
| T1/T2 with `--network none` + UDS proxy | ● loopback-only netns (INFERENCE: standard Docker) | ● plus Netstack isolation (INFERENCE) | n/a | ● (INFERENCE) | ● `--unshare-net` (INFERENCE) | ● no NIC, vsock only (INFERENCE) | ● | ◐ |
| T3 persistence | ● read-only rootfs, tmpfs, `--rm` (INFERENCE) | ● (INFERENCE) | | ● | ◐ easy to get wrong (bind list is hand-built) (INFERENCE) | ● disposable rootfs (INFERENCE) | ● | ◐ |
| T4 escape | ◐ shared kernel; seccomp; no AppArmor (FACT F5); lands as a subuid if non-root (INFERENCE) | ● Sentry: host syscall surface is runsc's seccomp list (INFERENCE from gVisor security model) | | ● same Sentry; rootless (INFERENCE) | ○/◐ shared kernel; seccomp only if we supply a BPF filter; nested userns surface (INFERENCE) | ● KVM boundary (INFERENCE) | ● | ○ |
| T5 caps | ● `--cpus --memory --pids-limit` via delegated `cpu memory pids` (FACT controllers); no `io` (FACT) | ● rootful cgroups incl. io (INFERENCE) | | ◐ `--ignore-cgroups` in rootless; wrap in a systemd scope (INFERENCE) | ● via `systemd-run --user --scope -p MemoryMax= -p TasksMax= -p CPUQuota=` (INFERENCE) | ● fixed vCPU and RAM (INFERENCE) | ● | ◐ |
| Perf cost | ~none (FACT, current) | syscall- and file-I/O-heavy work slower: `npm ci` and vitest; size UNKNOWN, to be measured | | same as O2a | ~none | boot ~100s of ms (vendor claim); virtio-blk I/O; one image build per toolchain | similar to O4 + containerd | ~none |
| Maintenance | low: reuse image and `DockerSandboxExecutor` flags | medium: one static binary + `daemon.json` entry; upgrade monthly | | medium: OCI bundles from `docker export` | medium: hand-built mount lists per toolchain | **high**: guest kernel + rootfs pipeline, vsock agent | high | medium |
| Supply chain | base image by **digest** (today a tag: FACT); atomic-agent sha256 (FACT) | runsc release + `.sha512` from the gVisor release bucket, pinned in repo (INFERENCE: published per gVisor install docs; verify at install) | | same | Ubuntu package (apt-signed) | release binary + checksum; plus our own kernel and rootfs | many components | Ubuntu package |
| Codex's own sandbox inside | **no** without loosening seccomp (`unshare`/`clone` NEWUSER, mount); restrict=0 makes a custom-seccomp variant likely to work (INFERENCE), but that is the loosening we declined on 18-10 | **likely**: gVisor implements userns for bwrap (FACT PRs) → works (INFERENCE); test A-C1 | | likely (INFERENCE) | nested bwrap in bwrap: likely with restrict=0 (INFERENCE) | **yes**: full guest kernel (INFERENCE, high) | yes | ? |
| GPU | none passed (FACT `Devices=[]`) | none | | none | must use `--dev /dev` (minimal); host `/dev/nvidia*` is 666 (FACT), so a bind mistake would expose the GPU | none | none | ◐ |

Notes:
- O1 must change three defaults to be the profile described here. (1) `--user 1000:1000` instead of root, so the
  host-side uid is subuid 100999 (INFERENCE from the `djimit:100000:65536` mapping), which owns nothing on the host.
  (2) Copy the worktree in and out (section 8.3) instead of bind-mounting a host-owned tree rw. (3) `--network none`.
- O3 is attractive as the lightest option and works rootless today, but every bind is our own code, there is no
  image story, and it shares the kernel. Use it only as the **inner** layer (Codex's own), not as our boundary.
- O2c is the only fully rootless gVisor path today. Its limits: no Netstack in `--rootless` (so no network, which our
  design wants anyway), no `create` (so `run` only), and cgroup errors ignored, so caps come from a systemd scope. It
  is a real alternative to O2a if the operator does not want the rootful daemon involved. Test both in R2.

## 8. Recommended design

### 8.1 Shape

```
VPS (control plane)                     Workstation (pull only)
remote_maker_jobs / gym claim  <──pull── worker (systemd --user, oneshot)
     ▲ patch + report only                  │ 1. fetch job (HMAC host-scoped token, unchanged)
     │                                      │ 2. prepare inputs from trusted refs (git bundle/archive at base_commit)
     └──────────────────────────────────────┤ 3. sandbox-run <job.json>   ← new, profile P1 or P2
                                            │      ├─ container/sandbox: --network none, ro rootfs, tmpfs, caps
                                            │      ├─ /run/egress.sock ← host egress proxy (allowlist per job)
                                            │      └─ /out (tmpfs, size cap): patch, logs, report.json
                                            │ 4. validate artefacts as data (patch checker, scrub, byte caps)
                                            │ 5. oracle: fresh sandbox, trusted base + validated patch, no network
                                            └ 6. post result; audit record; cleanup + verify
```

The runner is one new host-side script (`scripts/sandbox-run.mjs`, in a later PR). The gym worker and a future
remote-maker worker call it. This PR changes neither of them.

### 8.2 Job contract (input)

```jsonc
{
  "job_id": "uuid",                        // = remote_maker_jobs.id / gym attempt id
  "use_case": "U0|U1|U2|U3|U4|U5",
  "profile": "runc-hardened|gvisor",       // P2 required for U4, U5; operator may require it for U1, U3
  "image": "djimitflo-sbx-node22@sha256:…",// digest only; tags are refused
  "inputs": {
    "repo": "djimit/djimitflo",            // U4: allowlisted external repo id
    "base_commit": "40-hex",
    "overlay": [{ "path": "packages/x/__tests__/a.test.ts", "sha256": "…" }], // e.g. falsifier test
    "deps": "lockfile-cache:<sha256 of package-lock.json>|install-in-sandbox"
  },
  "steps": [                                // fixed by use case on the runner, never agent-supplied argv
    { "name": "make",   "argv_ref": "maker:atomic@llama-router", "network": "allowlist", "wall_s": 900 },
    { "name": "oracle", "argv_ref": "vitest:file",               "network": "none",      "wall_s": 300 }
  ],
  "egress": [{ "id": "llama-router", "route": "http://127.0.0.1:8084", "max_requests": 400, "max_tokens": 2000000 }],
  "credentials": [],                        // U1/U3 only, see 9.2; each { kind, scope, ttl_s, source }
  "resources": { "cpus": 4, "memory_mb": 6144, "pids": 512, "tmpfs_mb": 4096, "out_mb": 16, "log_bytes": 1048576 },
  "gpu": "none"                             // fixed; no device is ever passed
}
```

Result (output; shape aligned with the existing remote result plus the failure-capture work):

```jsonc
{
  "job_id": "…", "status": "done|failed|killed|infra_failed", "reason": "…",
  "steps": [{ "name": "make", "exit": 0, "signal": null, "timed_out": false, "oom_killed": false, "wall_ms": 123 }],
  "artefacts": { "patch_sha256": "…", "patch_bytes": 1234, "log_sha256": "…", "log_truncated": false },
  "egress": [{ "id": "llama-router", "requests": 31, "bytes_out": 0, "bytes_in": 0 }],
  "denied": [{ "dest": "192.168.1.1:445", "count": 2 }],   // → policy_violations
  "sandbox": { "profile": "runc-hardened", "runtime": "runc 1.5.1", "image": "sha256:…", "profile_sha256": "…" },
  "cleanup": { "containers_left": 0, "volumes_left": 0, "verified": true }
}
```

Rules:
- The argv comes from the runner's step table, keyed by use case and species. Job data can select a step; it can never
  supply a command. This is the same principle as the falsifier ("the submitted command is stored, never executed").
- Everything the agent produces is **data**. The host never executes it, never runs `git` in it, and never follows its
  symlinks.

### 8.3 Inputs and artefact export

- **In.** The host builds the tree from trusted objects (`git archive <base_commit>` from the worker's own clone, plus
  overlay files checked by sha256). It copies the tree into a per-job named volume or tmpfs, owned by the container uid.
  No host directory is mounted rw.
- **Dependencies.** For our own repo, use a read-only, lockfile-keyed `node_modules` cache (the MAKER_WARM_DEPS idea),
  built in a separate trusted step from the **base** lockfile with `--ignore-scripts`, or with scripts but inside the
  sandbox for U4. Mount it read-only. The `djimitflo-gym-npm` volume stops being rw-shared across jobs (T3: cache
  poisoning).
- **Out.** Inside the sandbox, a fixed final step runs `git diff --binary <base>` with `-c core.hooksPath=/dev/null` and
  writes `/out/patch`; logs are capped to `log_bytes`. `/out` is a size-capped tmpfs the host reads after the sandbox has
  stopped.
- **Host-side validation (pure functions, unit-tested).** Patch ≤ `MAX_PATCH_BYTES` (2 MiB, existing); no paths
  outside the tree or under `.git/`; no symlinks; no mode changes to executable unless the use case allows it; no
  submodule or gitlink entries; changed paths ⊆ the use case's scope (gym: `task.source`; falsifier: the test file).
  Logs and patch are scrubbed with `redactSecrets` **and** an exact-match check against secret values the host knows
  (worker tokens, the per-job credential). A hit fails the job and records a violation; it is never silently redacted.
- **Oracle.** It runs in a **second, fresh** sandbox: trusted base, validated patch applied there with `git apply` and
  safe config, no network, its own report path. This closes T6: the maker's sandbox never sees the reporter output the
  verdict is read from.

### 8.4 Network policy

- **Default `none`.** The sandbox has a loopback-only netns: Docker `--network none`, runsc `--network=none`.
- **Egress, when a step needs it.** The host runs an egress proxy, one per job, started by the runner and stopped with
  it. The proxy listens on a Unix socket bind-mounted at `/run/egress.sock`. A small pinned forwarder inside the image
  (`socat` or a 30-line Node bridge) exposes it on `127.0.0.1:<port>` inside the sandbox. This is the same shape as
  Codex's managed-proxy mode.
  - For gVisor, connecting to a host UDS needs runsc's host-UDS option (`--host-uds=open`). INFERENCE: verify in R2.
  - Route types are (a) fixed reverse-proxy routes (`llama-router` → `127.0.0.1:8084`, with request and token budgets
    for T5) and (b) HTTPS `CONNECT` to allowlisted `host:443` (e.g. `chatgpt.com`, `api.openai.com`, one OCR provider;
    `registry.npmjs.org` only in an install step).
- **The proxy decides by resolved IP, not by name.** After DNS resolution it rejects 127/8 (except fixed routes it owns),
  10/8, 172.16/12, 192.168/16, 100.64/10 (tailnet), 169.254/16, ::1, fc00::/7, fe80::/10, and the VPS and workstation
  addresses. It pins the connection to the checked IP (DNS rebinding).
- **Never** the tailnet, LAN, NAS, Docker bridges, LXD bridge, Ollama `:11434`, or the model servers except through a
  budgeted fixed route.
- Each denied attempt is counted in the result and becomes one `policy_violations` row per (job, dest), kind
  `sandbox_egress_denied` (new kind, shadow log, same `recordPolicyViolation` path as `outbound_denied`). The proxy logs
  bytes per route.
- **Defence in depth (operator decision D7).** An nftables **output** rule on the workstation, `meta skuid` = the
  sandbox subuid range → drop. It catches a P1 sandbox that somehow gets a network. It does not cover the proxy, which
  runs as `djimit`.

### 8.5 Secrets policy

- Nothing from the host environment enters the sandbox. The env is built from an explicit list (as `runChild` does in
  the falsifier), with a synthetic `HOME=/tmp/home` (OCR finding: it reads `~/.zshrc` exports and `ANTHROPIC_*`).
- No host path under `$HOME` is mounted, except per-job copies of a credential when the use case needs one.
- Worker tokens (`~/.djimit/*`) never leave the worker process. The sandbox never talks to the VPS; the worker posts
  results.
- A credential, when strictly required (U1, U3, U0 maker), comes as a per-job file on tmpfs, deleted at the end. Its
  sha256 is recorded before and after. A changed file (for example a refreshed token) is flagged and not copied back
  automatically: the operator decides whether refresh write-back is allowed (D4).

### 8.6 Resources

- cgroup v2 limits via the runtime: `--cpus`, `--memory` with `--memory-swap` = memory (no swap), and `--pids-limit`.
  The rootless delegation has `cpu memory pids` (FACT), so this works for P1.
- No `io` controller is delegated (FACT), so disk I/O is bounded by tmpfs sizes (which count against memory) and the
  `/out` cap.
- Wall-clock kill has two layers: `timeout -s KILL` inside, and the runner killing the container by name plus the label
  sweep (#541 pattern, label `djimitflo-sbx-host=<GYM_HOST>`, separate from the gym label so the two sweeps never
  overlap). An idle-output timeout catches hangs.
- Concurrency: one sandbox job per host by default, as today (oneshot). It can be raised per host after R2 measurements.
- GPU: `none`, fixed. Model use goes only through the budgeted proxy routes.

### 8.7 Audit record

There is one row per job (a new table on the VPS when the result is posted, or a field on the existing job rows; the
choice is made at implementation). It holds: job_id, use_case, host, profile, runtime version, image digest, profile
sha256 (hash of the full argv), input sha256s, egress routes with counts, denied attempts, credentials used (kind and
scope, never the value), resources and limits hit, exits, artefact sha256s, cleanup verified, and timestamps. Unknown
values are `null` with a reason, never 0. Runtime admission gets an entry per runtime@version that runs inside the
sandbox. Its `containment` gate cites the sandbox profile sha256 and the acceptance run that proved it.

### 8.8 Cleanup

The cleanup sequence is:
1. Remove the container (`--rm`, then `docker rm -f` by name on any error or signal, as `inRunner` already does).
2. Remove the per-job volume and stop the per-job proxy.
3. Delete the tmp dirs.
4. At start and end, sweep by `djimitflo-sbx-host` label (containers and volumes). For runsc, also check `runsc list`.
5. Record the result in `cleanup.verified`. Anything left blocks the next claim and becomes an `infra` reason, not a
   silent leak.

## 9. Codex (U1)

### 9.1 Making it run

Codex's `workspace-write` mode needs bwrap to create a user namespace, mount and `--unshare-net`.

| Where | Will its sandbox work? | Our verdict |
|---|---|---|
| VPS prod container | no: host `restrict=1`, CapEff 0, docker-default AppArmor (FACT, 18-10 tests) | stays off |
| P1 runc-hardened | no, unless seccomp is loosened for `unshare`/`clone(NEWUSER)`/`mount`; restrict=0 means it would then likely work (INFERENCE) | not recommended (weakens the outer boundary for every syscall the profile adds) |
| P2 gVisor | likely (INFERENCE: Sentry implements userns for bwrap) | **recommended, gated on acceptance test A-C1** |
| P3 Firecracker | yes (INFERENCE, high) | fallback if A-C1 fails |
| P2 with `--sandbox danger-full-access` | n/a: the outer sandbox is the only boundary | acceptable fallback **only** with 9.2 mitigations; operator decision D3 (the earlier VPS variant was blocked by the classifier, not by the operator) |

Why the inner sandbox matters: with it, the commands the model issues run with no network, while the Codex process
itself talks to OpenAI through the proxy. Without it, any command can use the OpenAI-only egress route as well.

### 9.2 Subscription auth: the honest version

`auth.json` holds a ChatGPT `refresh_token`, an `access_token`, an `id_token` and `account_id` (FACT). That is
account-level, long-lived authority. OpenAI offers no per-job or per-repo scoping for subscription auth that we know of
(UNKNOWN; none found). Whatever file Codex can read, a command it runs can read too. Codex's `workspace-write` mode keeps
the whole filesystem readable (INFERENCE from its documented policy).

| Option | Blast radius if the model or an injected repo turns hostile | Cost | Status |
|---|---|---|---|
| A1 per-job copy of the full `auth.json`, egress OpenAI-only, inner sandbox on, artefact exact-match scrub, hash check | The token can be read. Exfiltration routes left: OpenAI endpoints (can't reach an attacker directly), the patch and logs (blocked by the exact-match scrub), and a covert channel through prompts to OpenAI (residual). Account takeover is possible if a route is missed. | none | **recommended with D2** |
| A2 copy without `refresh_token` | Shorter lifetime. Whether Codex runs without it, and the access token's lifetime: UNKNOWN | none | test in R3; prefer it if it works |
| A3 host-side credential-injecting TLS proxy (sandbox holds a dummy token) | Smallest. The token never enters the sandbox | high: MITM CA in the sandbox; may break with Codex updates; ToS status UNKNOWN | not recommended now |
| A4 OpenAI **API** key, project-scoped, hard spend cap | Bounded by the cap; revocable per project | API spend (the operator said no API budget on 18-10) | cleanest; operator decision D2 |
| D2 add-on: a **dedicated** ChatGPT seat for the sandbox, not the operator's own | A takeover hits a throwaway seat | another subscription | strongly advised with A1/A2 |

Revocation path: sign out all sessions for that account, then recreate `auth.json` on the host. Record this in the
runbook before R3.

Claude Max has the same structure (OAuth credentials). The same table applies if a Claude species moves into the
sandbox.

## 10. Use case 0: VPS execution of agent code

**Constraints (FACT).** The VPS has 2 cores and 7 GiB. The container uid is 1001 with CapEff 0, so it cannot change uid
or create namespaces. The host has `restrict=1`, and there is no bwrap or runsc. `/data` (mode 777) holds the prod DB
(600, owned by 1001) and the worktrees (#948). No docker socket is in the container, and that should stay so (the prod
container must never get the socket).

| Option | Isolation of DB and control plane | Egress control | Fits 2 cores / 7 GiB | Change footprint | Verdict |
|---|---|---|---|---|---|
| V-A in-container: env scrub, cwd guard, `chmod` tricks | ○ the same uid can always open the DB | ○ none at process level (the outbound guard is `fetch`-only) | yes | small | **not sufficient**: there is no in-container fix (CapEff 0, no userns) |
| V-B sidecar sandbox worker on the VPS **host** (systemd unit with host Docker access), pulling jobs from the API exactly like the workstation worker, running P1 (rootful runc there: AppArmor docker-default plus our flags, non-root uid) | ● DB not mounted; tree from a host-side mirror; patch out only | ● same UDS proxy | tight: makers mostly wait on model APIs (INFERENCE); `npm ci` + vitest compete with prod for 2 cores; needs cpu caps so the server stays responsive | medium: new host unit; worktrees move out of `/data` for these jobs | **fallback** and latency path |
| V-C route to the workstation via `remote-maker-queue` (`REMOTE_MAKER_ENABLED`, exists) + runner P1/P2 | ● as V-B, and off the prod host entirely | ● | n/a: workstation has 48 cores, 125 GiB | small on the VPS (enqueue instead of local run); runner work on the workstation | **primary** |

V-C needs these, all of them operator decisions:
- **Availability.** When the workstation is down, jobs time out (`queue_timeout`, existing) and are reported as
  infra. They never fall back to running unsandboxed on the VPS. That fallback would silently undo U0. The fallback is
  V-B, or a wait.
- **Scope.** The checks that run maker-modified code (deterministic checks: `npm ci` and its lifecycle scripts from a
  maker-edited `package.json`, lint and tests on the patched tree) are also agent code. They must move with the maker,
  or run in the sandbox's oracle step. Panel and LLM checkers that only read the diff can stay on the VPS.
- **Model access from the workstation.** Some prod makers use Ollama Cloud, Claude or Codex credentials held on the VPS.
  Under V-C they use the workstation's credentials (9.2), or a per-job credential the VPS issues. The second means the
  credential travels in the claim response, which needs an HMAC-scoped, short-TTL design. It is UNKNOWN whether any
  provider supports that for subscriptions. The first is simpler.
- **Data movement.** Only base commit, prompt and (for checks) the patch go out; only patch and report come back. This
  is unchanged from `remote-maker-queue`.

## 11. Rollout (shadow steps, in order)

Each step needs the previous one's acceptance criteria passed and the operator's go. Flag:
`SANDBOX_RUNNER_MODE=off|shadow|on` per use case (`SANDBOX_RUNNER_USE_CASES=U2,U0-check,…`). The default is off, and
off means today's behaviour.

| Step | What | Use case | Install needed | Exit criterion |
|---|---|---|---|---|
| R0 | This doc reviewed; operator decisions D1–D9 | n/a | none | decisions recorded |
| R1 | `sandbox-run` + P1 profile + egress proxy + artefact validator, with unit tests; run the **escape battery** (section 12) on the workstation. No real jobs. | none | none | battery all-pass under P1 |
| R2 | P2: install runsc (D1); repeat the battery under P2; measure `npm ci` + a vitest file + the server suite under P1 vs P2 | none | runsc | battery all-pass; overhead recorded (no threshold assumed) |
| R3a | **U0 shadow:** the VPS keeps running as today, and the same check step is also run on the workstation through the queue in P1 for N jobs; compare verdicts | U0 | none | agreement ≥ the operator's bar (D8) over ≥ 20 jobs; disagreements explained |
| R3b | **U2 shadow:** falsifier tests run in the sandbox (P1, no network) on the workstation; `COMMONS_FALSIFIER_AGENTS` still empty on the VPS | U2 | none | ≥ 20 runs, verdicts agree with a local trusted control run; zero denied-egress surprises |
| R4 | **U0 act** (D5): prod checks for maker-modified trees run only in the sandbox; then makers | U0 | none | no regression in verified rate over the experiment window (period boundary recorded) |
| R5 | **U1 Codex shadow** in P2: A-C1 test, then gym attempts with the auth option chosen in D2 | U1 | runsc (R2) | inner sandbox works or fallback chosen; scrub hits 0; no auth-file hash change unexplained |
| R6 | **U2 act:** open the falsifier allowlist (D6) with sandboxed execution only | U2 | none | as R3b plus 14 days without a violation |
| R7 | **U3 OCR** native binary in P2 with one provider route (per #942 adapter design) | U3 | none | trial runs per frozen EVAL_PROTOCOL |
| R8 | **U4 external repos:** P2 mandatory, install-in-sandbox with registry-only egress, model route during make, none during test | U4 | none | per-repo admission |
| R9 | **U5 community tools:** P2, no network by default; per-tool allowlist after review; runtime-admission entry required | U5 | none | per-tool admission |

The coordinator's order has U0 first. R3a and R3b can run in parallel because both need no credentials.

## 12. Tests and acceptance

**Unit tests (repo, CI).** Each fails on code without the feature.
- Arg builder: the P1 and P2 argv always contain `--network none`, `--read-only`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--pids-limit`, `--memory` = `--memory-swap`, a non-root `--user`, the sbx label,
  and no `-v` source under `$HOME` except the per-job credential path. A digest-less image is refused.
- Job contract validator: unknown use case, agent-supplied argv, `gpu` ≠ `none`, or a missing wall-clock is refused.
- Egress matcher: every private, CGNAT, loopback, link-local and ULA range is denied after resolution; an allowed name
  resolving to 100.86.47.122 is denied; fixed routes only.
- Patch validator: `.git/` paths, symlinks, gitlinks, out-of-scope paths and oversize patches are rejected; scope rules
  per use case.
- Scrub: an exact-match secret in a log or patch fails the job and records a violation.
- Result: an unknown or missing field is `null` with a reason, never 0.

**Escape battery (host, R1 and R2, recorded as acceptance evidence for runtime admission).** Each probe runs as the job
payload and must fail as stated.

| ID | Probe | Expected |
|---|---|---|
| E1 | `cat ~/.djimit/gym-worker.token`, `~/.codex/auth.json`, `/home/djimit/*` | ENOENT (not mounted) |
| E2 | TCP to 100.86.47.122:3001, 192.168.1.1:80, 192.168.1.28:445, 127.0.0.1:8084, 127.0.0.1:11434, [fd7a:…]:4000 | no route / refused; via proxy: denied + counted |
| E3 | DNS lookup of an allowed name that resolves to a private IP (test resolver) | denied by the proxy |
| E4 | Connect to abstract socket `@…/bus/systemd/bus-system` | fails (no shared netns) |
| E5 | Write `/etc/x`, `/usr/x`, `/run/x` | EROFS |
| E6 | Fork bomb; allocate memory beyond the limit; 100 MB of stdout | pids limit hit; OOM recorded; log truncated + flagged |
| E7 | `sleep infinity` | killed at wall-clock; no container left (sweep verified) |
| E8 | `ls /dev/nvidia* /dev/dri /dev/kvm` | absent |
| E9 | Replace `.git` with a dir with `core.fsmonitor=touch /tmp/pwned`; plant a symlink to `/etc/passwd` in scope | host never runs it (no `/tmp/pwned` on host); patch rejected |
| E10 | Uid mapping: host-side `/proc/<pid>/status` of the job process | P1: subuid (≠ 1000); P2: Sentry/Gofer uid and CapEff recorded |
| E11 | P2 only: `dmesg` / `/proc/version` inside | gVisor signature (proves the runtime really is runsc) |
| E12 | Persistence: after the job, no container, volume, process or file with the job label or id outside `/out` | none |
| A-C1 | Codex `exec --sandbox workspace-write` writing a file and running `curl` inside P2 | write OK; curl blocked by Codex's own sandbox |

**Rollback.**
- Flag off restores today's behaviour per use case. No data migration is involved: the audit rows stay.
- For runsc: remove the `runtimes.runsc` entry from `/etc/docker/daemon.json`, restart the rootful daemon (operator),
  and delete the binary. P1 needs no install, so it has no install to roll back.
- If R4 (U0 act) shows a regression, set the flag off for U0. Jobs then run on the VPS as today, which is knowingly the
  unisolated state, so this is an operator decision and is recorded.

## 13. Unknowns, to be closed by tests, not assumed

- Does runsc register cleanly on the rootful daemon on this host, and does `--host-uds=open` connect to a bind-mounted
  proxy socket under `--network=none`? (R2)
- Does `runsc --rootless run` (O2c) work here with cgroup caps from a systemd user scope? (R2, alternative to O2a)
- gVisor overhead for `npm ci` + vitest on this workload. (R2)
- Does Codex's bwrap work inside runsc (A-C1)? Does Codex run with an `auth.json` lacking `refresh_token` (A2)? (R5)
- Whether OpenAI offers any scoped credential for subscription Codex use. (none found)
- Whether `djimit` has passwordless sudo. Not checked, because it is not needed for the design and the check itself
  is a privilege probe.
- Whether a Docker CLI exists inside the prod image. The in-container probe was refused; the socket is not mounted
  (FACT).

## 14. Decisions needed from the operator

- **D1** Install runsc (release `release-20261012.0` or newer, sha512 pinned in this repo) on the workstation and
  register it with the **rootful** daemon (root needed). Or prefer the rootless standalone path (O2c), or wait for
  gvisor#14578.
- **D2** Codex auth: A1 (full copy) vs A2 (no refresh token, if it works) vs A4 (API key with cap). Also whether to use a
  dedicated ChatGPT seat for the sandbox.
- **D3** If A-C1 fails: is `--sandbox danger-full-access` acceptable inside P2 (outer sandbox as the only boundary), or
  go to Firecracker (P3, add `djimit` to `kvm`)?
- **D4** Is the refreshed `auth.json` ever written back from a job? The recommendation is no: refresh on the host only.
- **D5** U0: V-C (workstation, primary) and/or V-B (VPS host sidecar). Also: when the workstation is down, accept
  stalled makers rather than unsandboxed local runs.
- **D6** When to open `COMMONS_FALSIFIER_AGENTS` (after R3b + R6 criteria).
- **D7** Add an nftables output rule on the workstation that drops traffic from the sandbox subuid range (defence in
  depth).
- **D8** The verdict-agreement bar for R3a and R3b.
- **D9** Fix now, independent of this runner: the current gym runner's `--network host`, no caps, and host-side git on
  the agent tree (F1–F4). The smallest step is the P1 flags, plus doing the diff inside the container. It touches
  `gym-worker.mjs`, so it is a separate, explicitly allowed task.
- Also consider: `djimit`'s `docker` and `lxd` group memberships make any host-level compromise root. Can the worker
  run as a dedicated user without them? That is a larger host change and is listed for completeness.

## 15. Reuse map

- `scripts/gym-worker.mjs`: claim/post protocol, `runnerArgs` label and name scheme, orphan sweep (#541), canaries
  (RX-11). The runner is called by it later; this PR does not modify it.
- `remote-maker-queue.ts`: job queue, host-scoped claim, `MAX_PATCH_BYTES`, lease identity (§3d), `queue_timeout` and
  `work_timeout`.
- Host-scoped HMAC worker tokens (`routes/remote-gym.ts`, `spawnTokenRejection`, scope `gym-worker`): unchanged; the
  sandbox never holds one.
- `execution/executors/docker-sandbox-executor.ts`: hardened flag set and its tests (F8).
- `execution/runtime-admission.ts`: the `containment` gate cites the sandbox profile and acceptance run;
  `supply_chain` cites the pinned digests.
- `utils/outbound-guard.ts` + `services/policy-violations.ts`: same shadow-violation recording, new kind
  `sandbox_egress_denied`.
- `commons-falsifier.ts` `runChild`: minimal-env pattern; its `run` dep becomes a sandbox job.
- #942 `ADAPTER_DESIGN.md`: synthetic HOME, native binary by sha256, rule-file deletion. These become the U3 step
  definition.
