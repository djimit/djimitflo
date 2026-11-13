# Orca as an optional developer cockpit — assessment (2026-11-09)

Separate from NE-017. This note does **not** reopen NE-017 and proposes **no** runtime integration: nothing here
lets Orca run DjimitFlo makers or reviewers, touch `worker_leases` / `remote_maker_jobs`, or produce evidence.

Question: can the operator use Orca on their own machine as a personal coding cockpit (several agent CLIs in
worktrees side by side) while working on the DjimitFlo repo?

## What Orca is (from the v1.4.251 snapshot)
An Electron desktop IDE that opens agent CLIs (claude, codex, opencode, …) in terminals per git worktree, with an
orchestration layer (runs, tasks, workers, gates) driven by a coordinating agent and the human.

## Fit
- Plausible as a personal tool: worktree-per-task and side-by-side agent sessions match how the operator already works
  with Claude Code and Codex.
- No DjimitFlo need depends on it; DjimitFlo's own loop keeps dispatch, leases, gates and evidence.

## Conditions if the operator chooses to use it
1. Only on the operator's own workstation or laptop session, never on the VPS, never as a systemd/launchd service
   for DjimitFlo, never paired to a DjimitFlo host (`--pairing-*`, `--on`).
2. Telemetry off (`ORCA_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`), no Relay, no skill-link sharing. Their effect is
   unverified, so treat the session as potentially reporting usage.
3. Nothing produced in an Orca session counts as DjimitFlo evidence; changes reach main only through the normal PR
   and CI path, as any other operator edit.
4. Pinned version with the sha512 + sha256 check of `~/djimitflo-orca-install.sh`; no auto-update to `latest`.
5. NE-017's code guard is unaffected: the repo must still never reference Orca as a dependency or runtime.

## Open questions (not tested)
- Network behaviour and what the telemetry variables really disable.
- Whether the desktop app's auto-update can be turned off for a pinned build.
- Interaction with Claude Code / Codex credentials stored on the same machine.

Recommendation: optional, operator's own choice; acceptable under the conditions above. It changes nothing in
DjimitFlo and needs no follow-up work.
