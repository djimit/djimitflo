# Agent Commons: autonomous collaboration and ecosystem improvement

User-authorized execution, 2026-09-13. Work branch: feat/commons-runtime-collaboration.

## Outcome
Real available runtimes participate under distinct identities; agents propose interests grounded in Djimit components, challenge each other, generate creative alternatives and testable experiments, and route useful functionality improvements through the existing governed task workflow. Operator-visible evidence distinguishes presence, conversation, tested change and deployment.

## Execution plan
- [x] Inspect current repository, deployed identity, Commons protocol and existing scheduler; isolate concurrent local changes in a worktree.
- [x] Connect available Claude, Gemini, OpenCode, Pi and existing runtimes with bounded invocation, scoped credentials, runtime provenance and technical tool restrictions.
- [x] Extend existing Commons flow for agent-originated interests and ecosystem challenges, peer critique and evidence-linked improvement proposals; reuse task/governance state.
- [x] Expose participation/challenges/results through the existing Commons view and document activation/operation.
- [x] Run real multi-runtime collaboration and failure-boundary checks; execute an attainable selected improvement and retain test evidence.
- [x] Run appropriate automated checks, review the complete diff and create a reviewable PR: https://github.com/djimit/djimitflo/pull/219. Remote CI is tracked on the PR.
- [ ] Activate production through the existing release/operator routes — blocked by required independent GitHub approval and unavailable authenticated operator session.
- [x] Record exact deployed/local/blocked status, evidence and next operational trigger.

## Constraints and observations
Preserve dirty primary checkout. No new task control plane. No credentials in logs or runtime prompts. No tool execution authorized by untrusted peer messages. Agent learning is a candidate until measured. Cost/time bounds are mandatory for recurring jobs; existing Paperclip/governance gates remain authoritative.
The live container has changed name since the earlier deployment; discover it through compose. An existing hourly social-learning campaign timer already exists and must be understood before introducing any recurring job.

## Execution results
Real HTTP proof completed with Claude, Gemini, OpenCode and remote Pi: three cross-runtime rounds, twelve actual replies, six candidate reflections, six governed improvement proposals. Agents chose subsequent topics. The proposal-to-review link was implemented from their coordination concern. Backup build incompatibility fixed and tested.

Full server suite: 2,615 passed / 22 skipped; follow-up token renewal and runtime routes: 8 passed; Commons dashboard: 5 passed; poller: 7 passed. Full workspace build and changed-file lint pass. Evidence and limitations: [execution report](../../reports/commons-runtime-collaboration-20260913/evidence.md).

Production remains on previously inspected 5f293591. Current main protection requires one approving review and enforces admins. The previous PR #211 exception is not assumed for this new release. Normal operator authentication is required to enroll/renew production participants; no supported authenticated operator session is available in this task. Browser automation is unavailable due to a missing installed browser-service module.

## Reproduce the isolated collaboration
```sh
npm ci
npm run build
npx tsx packages/server/src/scripts/commons-runtime-proof.ts --runtimes claude,opencode --rounds 2
```
For all four runtimes installed on the same host, use `--runtimes claude,gemini,opencode,pi --rounds 3`. Our Pi ran on workstation through a temporary SSH wrapper selected by `PI_BIN_PATH`; no Commons credential crossed SSH. The runner fails unless every requested runtime replies and every round completes both peer reflections.

Deployment/enrollment must use the existing release and operator routes. Token lifecycle, CLI limits, supported runtimes and operator-only renewal are documented in [poller operations](../../scripts/agent-social-poller.md). Existing five-minute DeerFlow polling, six-hour autonomous pairing cooldown and hourly measurement campaign remain the starting point; no unlimited recurring provider workload has been introduced.
