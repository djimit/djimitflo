# Fleet event bus and agent registry auth (S3)

Closes SECURITY_GAPS **S3** (`docs/research/mcp-a2a/SECURITY_GAPS.md`) step by step: the event bus (`/srv/event-bus`, `:8083`)
and the agent registry (`/srv/agent-registry`, `:8088`) on vps-agentical accept writes from anyone on the tailnet.
This runbook installs a per-host bearer token check, first in `log` mode (nothing is refused), then in `enforce`.

Everything below that touches the VPS runs as **root on vps-agentical** and is the operator's step. The PR only
prepares the files: `infra/event-bus/`, `infra/agent-registry/` (the first commit imports the files running today, byte
for byte, so the second commit is the reviewable change).

## What is protected

| Service | Protected (token needed in `enforce`) | Open in this step |
|---|---|---|
| event bus `:8083` | `POST /events/{stream}` (publish), `POST /streams/{stream}/groups` | `GET /events/{stream}`, `GET /streams`, `GET /health` |
| agent registry `:8088` | `POST /agents/{name}/heartbeat`, `POST /memory/write`, `POST /memory/search`, `DELETE /memory/{id}`, `POST /knowledge/agent/{name}/register`, `POST /context/forward`, and the reads that return memory contents: `GET /memory/list`, `GET /knowledge/search`, `GET /context/receive/{agent}` | `/health`, `/daps/status`, `/agents…`, `/topology`, `/compat-warnings`, `/knowledge/sources` |

Both services also get `GET /auth/status` (open): mode, known host names, authenticated requests per host and the
unauthenticated callers (kind, method, path, client address, Host header, self-declared source, count) since the
container started. It never shows a token or a token hash.

Bus reads stay open on purpose in this step: Eve-V polls `GET /events` about 1 200 times a day. Closing reads is the
next step, once every reader sends its token (see "Next steps").

## The mechanism

- `AUTH_MODE=off|log|enforce`, default **log**. An unknown value counts as `log` and is warned about at start.
  - `log`: a protected request without a valid token is served as before, and a `fleet_auth unauthenticated …` line is
    logged with the client, Host header, method, path, source and a running count.
  - `enforce`: the same request gets `401` (`WWW-Authenticate: Bearer`) and never reaches the route.
  - `off`: no check (the rollback switch).
- Header: `Authorization: Bearer <token>`. One token per host. The token never travels in a URL.
- The services hold **only the sha256 of each token**, in `/etc/djimit-agents/fleet-auth/tokens` (mounted read-only as
  `/run/fleet/tokens`), one line per host: `<host> <sha256 hex>`. A leak of that file, or a copy-paste of a line, gives
  nothing usable. The file is re-read when it changes: adding, rotating or revoking a host needs no restart.
- Constant-time compare (`hmac.compare_digest`) against every entry, no early exit. Token values are never logged.
- A missing tokens file means no known hosts: `enforce` then refuses every protected request (fail closed).

### Relation to the fleet event signatures

Same identity model as `FLEET_EVENT_SIGNATURES` (`packages/server/src/services/fleet-event-signatures.ts`): one identity
per host name, a server-side registry, nothing taken from the request except the credential, the secret in
`~/.djimit/` with mode 600. Use the **same host names** as in `fleet_event_keys` (`workstation`, `macmini`,
`djimit-Eve-V`, …).

It is deliberately a different secret. A bearer token travels with every request, so the bus sees it. The signing
key `~/.djimit/fleet-event.key` must never leave its host: if it were the bearer, the bus, or anyone who can read its
memory, could forge signed `agent.outcome` events. The two layers stack: the token says which host may publish, the
signature proves which host produced an outcome.

## Who writes to the bus today (30 days to 2026-10-22)

The client address comes from the bus access log (`docker logs --since 720h event-bus`, 13 148 POSTs, all `200`).
The source comes from the events themselves (13 149 events in `djimit.events` over the same 30 days). The two were
matched by count. The VPS's own callers show up as the docker gateway (`172.20.0.1` for the bus, `172.18.0.1` for the
registry).

| Host (tailnet name, IP) | Bus POSTs | Self-declared sources | Bus reads | Registry |
|---|---|---|---|---|
| **vps** (agentical, 100.86.47.122 → 172.20.0.1) | 2 649 | `djimitflo`, `self-improvement`, `loop_finding`, `loop_learning_closure`, `disk_guard` (all from the Djimitflo outbox) | 40 819 (Djimitflo ingest) | `GET /agents` 8 320 (Djimitflo registry sync) |
| **macmini** (mac-mini-van-home-1, 100.101.220.31) | 7 747 | `djimitflo-scout` 7 022, `hermes-macmini` 723 | 21 | – |
| **djimit-Eve-V** (100.78.97.2) | 1 267 | `hermes-eve-v` 771, `eve-action-processor` 516, `eve-maintainer` 16 (signed) | 34 936 (Eve-V poller) | – |
| **macbook** (denniss-macbook-pro, 100.83.83.81) | 1 072 | `operator-chatgpt` 1 072 | – | 3 GET |
| **workstation** (100.81.133.48) | 413 | `djimit-kbwiki` 412 (signed `agent.outcome`), 1 other | – | – |
| **agenticservices** (100.77.58.72) | 0 | – | – | 3 GET |
| **djimit-web** (100.96.192.29) | 0 | – | – | – |

Not attributed by count: `daps` (29 `outcome.observed`, `runtime_identity eve-v:hermes-cron`), so either Eve-V or
the VPS. `/auth/status` in log mode will show which. **Nobody wrote to the registry in 30 days.** It received only
`GET` requests, and none of them read memory.

## Djimitflo and script side (this PR)

| Caller | Header since this PR | Token |
|---|---|---|
| outbox `event-outbox-service.ts` (POST) | already sent | `DJIMIT_EVENT_BUS_TOKEN` |
| board handoff `board-handoff-service.ts` (POST) | **new** | `DJIMIT_EVENT_BUS_TOKEN` |
| ingest `external-event-ingest-service.ts` (GET) | **new** | `DJIMIT_EVENT_BUS_TOKEN` |
| registry sync `agent-registry-sync-service.ts`, `/api/federation/fleet` (GET) | **new** | `AGENT_REGISTRY_TOKEN`, else `DJIMIT_EVENT_BUS_TOKEN` |
| `scripts/emit-agent-outcome.py`, `scripts/fleet-discovery-publisher.py` | **new** | `DJIMIT_EVENT_BUS_TOKEN`, else the file `DJIMIT_FLEET_BUS_TOKEN_FILE` (default `~/.djimit/fleet-bus.token`) |
| `scripts/wiki-delta-emitter.sh` | **new** (to curl on stdin, never argv) | same as above |
| roborev `~/scripts/ship-to-djimitflo.sh` (not in this repo) | already sent | `DJIMIT_EVENT_BUS_TOKEN` |

With no token set, nothing changes: no header is sent. This works until `enforce`.

Not in this repo, so the header has to be added where they live: the `operator-chatgpt` publisher (macbook), Eve-V's
`eve-action-processor` and the Hermes agents' own bus calls (when they do not use the scripts above), and the
`djimit_deep` runtime's `--event-bus-url` publisher (stream `deep-agent-executions`, no writes in 30 days).

## Per-host token (on each host, never pasted in chat)

Run this as the user that runs that host's emitters. Use `HOST` = the name from the check list.

```bash
HOST=macmini   # vps | workstation | djimit-Eve-V | macmini | macbook | agenticservices | djimit-web
umask 077; mkdir -p ~/.djimit
[ -s ~/.djimit/fleet-bus.token ] || openssl rand -hex 32 > ~/.djimit/fleet-bus.token
chmod 600 ~/.djimit/fleet-bus.token
# prints the ONLY thing that leaves the host: "<host> <sha256>" (not a secret)
printf '%s %s\n' "$HOST" "$(tr -d '[:space:]' < ~/.djimit/fleet-bus.token | openssl dgst -sha256 | awk '{print $NF}')"
```

Bring that one line to the VPS over ssh (it is a hash, so it can be seen, but keep the habit):

```bash
ssh vps-agentical "cat >> /etc/djimit-agents/fleet-auth/tokens" <<< "macmini 3f2a…"
```

Where each emitter reads the token:
- the scripts from this repo read `~/.djimit/fleet-bus.token` themselves (or `DJIMIT_EVENT_BUS_TOKEN` if set);
- roborev reads `DJIMIT_EVENT_BUS_TOKEN`. Export it in the wrapper that runs the ship step:
  `DJIMIT_EVENT_BUS_TOKEN="$(cat ~/.djimit/fleet-bus.token)"`. Do not put it in a crontab line, where it is visible;
- emitters in a container: mount `~/.djimit/fleet-bus.token` read-only, or pass it via an env file with mode 600;
- launchd/systemd units: an `EnvironmentFile`/wrapper that reads the file. Never put the value in the plist or unit.

Rotation: overwrite the host's token file, replace that host's line on the VPS (the last line for a host wins, but
delete the old one), and restart nothing. Revocation: delete the host's line.

## Install on the VPS (root, operator)

0. **Preconditions.** This PR is merged, and Djimitflo has deployed the merge commit. The auto-deploy timer does
   that, or run `bash scripts/deploy-vps.sh <sha> --apply`. Djimitflo then sends the header once its token is set
   (step 6). Before that, nothing changes.

1. **Backup** of the current dirs and images:

   ```bash
   TS=$(date -u +%Y%m%dT%H%M%SZ); B=/root/backups/fleet-auth-$TS; mkdir -p "$B"
   tar -C /srv -czf "$B/srv-event-bus-agent-registry.tgz" event-bus agent-registry
   docker image tag event-bus-event-bus "event-bus-event-bus:pre-auth-$TS"
   docker image tag agent-registry-agent-registry "agent-registry-agent-registry:pre-auth-$TS"
   echo "$B"
   ```

2. **Drift check.** The files to be replaced must still be the ones the PR imported. If a line fails, stop and diff
   it first:

   ```bash
   (cd /srv/event-bus && md5sum -c - <<'EOF'
   e9695af2652b6971e55032ce553935d6  main.py
   2b983d0322df7ab988d3718a766b348d  docker-compose.yml
   EOF
   )
   (cd /srv/agent-registry && md5sum -c - <<'EOF'
   935c9ba7d79a3909eefabf7ceb32a5ad  main.py
   cb9c7068d8b6570bb66e6bd6dc9479ab  docker-compose.yml
   EOF
   )
   ```

3. **Tokens dir.** Create it empty if absent. Host lines are added as the hosts produce them:

   ```bash
   install -d -m 755 /etc/djimit-agents/fleet-auth
   [ -e /etc/djimit-agents/fleet-auth/tokens ] || install -m 644 /dev/null /etc/djimit-agents/fleet-auth/tokens
   ```

4. **New files** from GitHub at the merge commit. Do not take them from a scratch worktree:

   ```bash
   SHA=<merge sha>; T=$(mktemp -d)
   git -C "$T" init -q && git -C "$T" fetch -q --depth 1 https://github.com/djimit/djimitflo.git "$SHA" && git -C "$T" checkout -q FETCH_HEAD
   for s in event-bus agent-registry; do
     install -m 644 "$T/infra/$s/main.py" "$T/infra/$s/fleet_auth.py" "$T/infra/$s/docker-compose.yml" "/srv/$s/"
     rm -rf "/srv/$s/tests" && cp -r "$T/infra/$s/tests" "/srv/$s/tests"
   done
   cmp /srv/event-bus/fleet_auth.py /srv/agent-registry/fleet_auth.py && rm -rf "$T"
   ```

5. **Build and test offline**, before anything restarts. `run` publishes no ports, and the tests replace Redis and
   Qdrant with fakes:

   ```bash
   cd /srv/event-bus && docker compose build event-bus && docker compose run --rm --no-deps event-bus python -m unittest discover -s tests
   cd /srv/agent-registry && docker compose build && docker compose run --rm agent-registry python -m unittest discover -s tests
   ```

6. **Djimitflo's own token** (host `vps`). It is generated on the VPS and never printed:

   ```bash
   umask 077; [ -s /etc/djimit-agents/fleet-bus.vps.token ] || openssl rand -hex 32 > /etc/djimit-agents/fleet-bus.vps.token
   printf 'vps %s\n' "$(tr -d '[:space:]' < /etc/djimit-agents/fleet-bus.vps.token | openssl dgst -sha256 | awk '{print $NF}')" >> /etc/djimit-agents/fleet-auth/tokens
   cd /srv/djimitflo && cp -p runtime.env "runtime.env.bak-$TS" && chmod 600 runtime.env   # it is 644 today
   grep -q '^DJIMIT_EVENT_BUS_TOKEN=' runtime.env || printf 'DJIMIT_EVENT_BUS_TOKEN=%s\n' "$(cat /etc/djimit-agents/fleet-bus.vps.token)" >> runtime.env
   docker compose up -d --force-recreate djimitflo
   ```

   `AGENT_REGISTRY_TOKEN` is not needed: the registry calls fall back to this token.

7. **Restart both services in log mode** (the default, no `.env` needed):

   ```bash
   cd /srv/event-bus && docker compose up -d event-bus        # redis is not touched
   cd /srv/agent-registry && docker compose up -d
   curl -fsS http://100.86.47.122:8083/health && curl -fsS http://100.86.47.122:8088/health
   curl -fsS http://100.86.47.122:8083/auth/status | python3 -m json.tool
   docker logs --since 10m event-bus 2>&1 | grep fleet_auth   # "service=event-bus mode=log hosts=vps,…"
   ```

   Smoke test: an unauthenticated publish is still served, and is now counted:
   `curl -fsS -X POST -H 'Content-Type: application/json' -d '{"source":"operator-probe"}' http://100.86.47.122:8083/events/probe.events`.
   It appears under `unauthenticated` in `/auth/status`.

## Cut-over

1. **Hosts.** On each host of the check list that writes, create the token, append its line on the VPS, and install the
   updated scripts from `origin/main` (see the check list). Verify in `/auth/status → authenticated` that the host
   name shows up.
2. **Log for at least 3 days** after the last host was switched. Then:

   ```bash
   docker logs --since 72h event-bus 2>&1 | grep -c 'fleet_auth unauthenticated'         # must be 0
   docker logs --since 72h event-bus 2>&1 | grep 'fleet_auth unauthenticated' | sed 's/.*client=\([^ ]*\).*source=\([^ ]*\).*/\1 \2/' | sort | uniq -c
   curl -fsS http://100.86.47.122:8083/auth/status | python3 -m json.tool               # authenticated: only known hosts
   ```

   Every remaining unauthenticated line names a client and a source. Fix that emitter, or decide it may stop. Only
   known host names may appear under `authenticated`.
3. **Registry first.** It had no writers and no memory reads in 30 days, so it can go to enforce as soon as its log
   is clean:

   ```bash
   cd /srv/agent-registry && echo AUTH_MODE=enforce > .env && docker compose up -d
   ```

4. **Then the bus**, under the same condition:

   ```bash
   cd /srv/event-bus && echo AUTH_MODE=enforce > .env && docker compose up -d event-bus
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' -H 'Content-Type: application/json' http://100.86.47.122:8083/events/probe.events   # 401
   ```

   After the switch, watch `fleet_auth unauthenticated … -> 401` lines and the Djimitflo ingest for one day.

## Rollback

- **Fast:** `AUTH_MODE=off`. No check, behaviour as before the PR, with the new code still in place:
  `cd /srv/event-bus && echo AUTH_MODE=off > .env && docker compose up -d event-bus` (the same in `/srv/agent-registry`).
  Use `AUTH_MODE=log` to go back one step.
- **Full:** restore the backup and rebuild:

  ```bash
  B=/root/backups/fleet-auth-<TS>
  for s in event-bus agent-registry; do rm -rf "/srv/$s.auth" && mv "/srv/$s" "/srv/$s.auth"; done
  tar -C /srv -xzf "$B/srv-event-bus-agent-registry.tgz"
  cd /srv/event-bus && docker compose up -d --build event-bus
  cd /srv/agent-registry && docker compose up -d --build
  ```

  The old services ignore the `Authorization` header, so the hosts' token files and `DJIMIT_EVENT_BUS_TOKEN` can stay.
- A single host is the problem: give it a new token and a new line, or (log/off only) leave it unauthenticated
  for now. Never put the token in a URL.

## Check list per host

| Host | Writes the bus? | What to do | Done |
|---|---|---|---|
| **vps** | yes (Djimitflo outbox, board handoff), reads the bus and the registry | Install step 6: `DJIMIT_EVENT_BUS_TOKEN` in `runtime.env`, chmod 600, recreate `djimitflo-live` after the merge deploy. If `daps` turns out to be a VPS job: give it the same token via its unit. | [ ] |
| **macmini** | yes (`djimitflo-scout`, `hermes-macmini`) | Token file for the user running `fleet-discovery-publisher.py` and `emit-agent-outcome.py`. Reinstall both from `origin/main` (grep the installed file for `bus_headers`). Line `macmini …` on the VPS. | [ ] |
| **djimit-Eve-V** | yes (`hermes-eve-v`, `eve-action-processor`, `eve-maintainer`, maybe `daps`) | Token file. Scripts from `origin/main`. Add the header to `eve-action-processor`'s publish (not in this repo); its GET poll may stay as is for now. Line `djimit-Eve-V …`. | [ ] |
| **macbook** | yes (`operator-chatgpt`); roborev ship (none in 30 d) | Token file. Add the header to the `operator-chatgpt` publisher. Export `DJIMIT_EVENT_BUS_TOKEN` from the file in the roborev ship wrapper. Line `macbook …`. | [ ] |
| **workstation** | yes (`djimit-kbwiki` signed `agent.outcome`; `wiki-delta-emitter.sh`) | Token file. `emit-agent-outcome.py` and `wiki-delta-emitter.sh` from `origin/main`. Line `workstation …`. | [ ] |
| **agenticservices** | no (3 registry `GET`s) | Nothing now. Create a token only when an emitter is added. | [ ] |
| **djimit-web** | no | Nothing now. | [ ] |

## Next steps (not in this PR)

- Close bus reads (`GET /events`) once Eve-V's poller and Djimitflo send their token. Djimitflo's ingest already does
  after this PR. The change is one line in `protected()` in `infra/event-bus/main.py`.
- S3 step 4: extend `FLEET_EVENT_SIGNATURES` to `roborev.*` and `outcome.*` before they create work.
- The registry's memory and context API had no callers in 30 days. Removing it is smaller than guarding it.
- Put `/srv/event-bus` and `/srv/agent-registry` under version control. From now on, `infra/` is the source to install from.

### Outbox envelope identity and source labels

Outgoing outbox `source` is the canonical publisher `djimitflo`; domain payloads
cannot override event type, event ID, correlation, timestamp or deduplication key.
For `djimitflo.work_item.created`, use `work_item_source` for the originating work
system. The publisher translates legacy queued `payload.source` into that field;
new producers persist it explicitly. Consumers selecting the old envelope source
must migrate their selector. External consumer compatibility has not been verified.
`EVENT_PUBLISH_ENABLED=false` also stops queued delivery before the next send;
a request already in flight may finish. Attempts and pending rows are retained.
