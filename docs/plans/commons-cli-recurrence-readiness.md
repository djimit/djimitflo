# Commons CLI recurrence readiness

Verified 2026-09-13 through the control-VPS Paperclip API: four new routines are
**paused**, each six-hour schedule is **disabled**. No execution wakeups or model
calls occurred. The seven existing enabled schedules and RoutineOps' shared
25/day cap are unchanged. Sanitized requests, responses and readback are in
`.data/commons-gap-cycle/recurrence.json`.

RoutineOps (`f5b246e5-0379-4c72-9dca-80ab265b4fe9`) owns readiness only.
The dedicated **4/day execution cap is NOT YET CONFIGURED**. All four descriptions
explicitly block activation. Scheduling uses native `skip_if_active`,
`skip_missed`, `0 */6 * * *`, timezone `Europe/Amsterdam`.

## Activation prerequisites

- All: admit a normal Djimitflo operator token-renewal session on the control host.
  No Commons/Djimitflo issuer secret was present in Paperclip's secret metadata.
  Paperclip's board credential cannot authenticate to Djimitflo. Only scoped
  social-runtime tokens may enter pollers; operator/refresh credentials stay out
  of model environments. A temporary 24-hour token is a canary, not durable renewal.
- OpenCode: `/usr/bin/opencode` 1.18.10 exists for the `paperclip` account. Existing
  native agents use the **Ollama** secret reference and custom provider config;
  **litellm-opencode-key** is another existing secret name. The Commons poller
  currently isolates that provider configuration, so explicit provider integration
  and a real no-tools canary remain necessary. No secret values were retrieved.
- Claude/Gemini: working CLI credentials remain on the MacBook; the Paperclip
  account lacks verified MacBook host-key/login admission. These CLIs are absent
  on the control host.
- Pi: the workstation's direct SSH path is denied by tailnet policy for the
  Paperclip account. No alternative route was attempted.

Before activation, bind an existing verified executable to a dedicated native
`process` adapter with `heartbeat.enabled=false`, `wakeOnDemand=true`,
`maxConcurrentRuns=1`, `maxDailyRuns=4`. Each invocation may process one leased
message with the poller's 150-second inference deadline and technical no-tools
restrictions. Its current verified readable path is
`/srv/djimitflo/runtime-source-156962b7/scripts/agent-social-poller.py`; the
self-test passed as `paperclip`. No new process agent or incomplete command was
registered. Do not lower the shared RoutineOps cap to simulate a dedicated limit.

The process adapter does not ingest nested CLI usage automatically. Report real
cost events through `/api/companies/:companyId/cost-events` where available;
unknown prices remain **unpriced**, not zero-cost. The four-run cap is a call-count
bound, not a currency guarantee. Auth/admission failure blocks activation; never
rerun inference just to retry submission of an available result. Changes remain
proposal candidates until the existing review/approval workflow accepts them.

## Inspect, stop and rollback

Use the existing board-authenticated API on the control VPS. Creation was
idempotent by exact title; pre-existing matching records must be preserved and
active matches reported, not modified. Company:
`c44afb8e-9ae9-4b60-8b35-895439ee5491`.

The following Node snippet uses the host's normal credential without printing it.
Pairs are, in order, Claude, Gemini, OpenCode and Pi. It only pauses these four
routines and disables their triggers:

```js
import fs from 'node:fs';
const credential = Object.values(JSON.parse(fs.readFileSync(
  '/home/paperclip/.paperclip/auth.json', 'utf8')).credentials)[0];
const pairs = [
  [
    "8285da69-e699-4267-80d3-540cc9a7c835",
    "98772f83-4689-433b-a6b4-4a755c438cb5"
  ],
  [
    "9d47fc45-5ab5-4c6d-8593-5c3ae2b1fe3a",
    "c71329dd-c031-48a3-9f37-f068afd49748"
  ],
  [
    "d9fdb9cf-6da0-4ae2-b4a3-81d7b6248b68",
    "714adbec-bb6f-48ea-90a3-63b9f7af6397"
  ],
  [
    "7fe4f0ec-0410-40c4-9500-d93dca528be7",
    "2b21a6af-ef3a-4bcc-962f-23b894ce4cf0"
  ]
];
async function api(method, path, body) {
  const response = await fetch(credential.apiBase.replace(/\/+$/, '') + path, {
    method, headers: { Authorization: 'Bearer ' + credential.token,
      'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(method + ' ' + path + ': ' + response.status);
  return response.json();
}
for (const [routineId, triggerId] of pairs) {
  const current = await api('GET', '/api/routines/' + routineId);
  await api('PATCH', '/api/routines/' + routineId,
    { status: 'paused', baseRevisionId: current.latestRevisionId });
  await api('PATCH', '/api/routine-triggers/' + triggerId, { enabled: false });
}
```

To cancel an in-flight execution, take each non-null `linkedIssueId` from
`GET /api/routines/:routineId/runs`, then fetch
`GET /api/issues/:linkedIssueId/live-runs`. Cancel each returned heartbeat `id`
with `POST /api/heartbeat-runs/:heartbeatRunId/cancel` using board authentication.
Do not pass a routine-run ID to the heartbeat cancellation route. None was
started by this setup.

Rollback is restricted to the four pairs above: after verifying the routine is
still paused and its trigger still disabled, `DELETE /api/routine-triggers/:id`
for that pair, then fetch the routine's fresh `latestRevisionId` and
`PATCH /api/routines/:id` with `{status:"archived",baseRevisionId:<fresh revision>}`.
There is no routine DELETE API; do not delete database rows. Trigger mutations
create revisions transactionally but do not accept a client baseRevisionId;
routine updates use the normal revision precondition. Preserve all other objects.
