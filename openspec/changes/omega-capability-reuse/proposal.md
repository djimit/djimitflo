# Bounded executable capability reuse

## Implemented scope

Extend the existing executable skill registry and maker assignment path under
`SKILL_FIRST_MODE`; do not add an orchestration or approval framework. Resolve
explicit capability intent, pin package identity through outcome recording, and
create bounded descendant candidates through the existing factory. Preserve
historical unknown identity as NULL. Harden existing approval continuation and
optional draft publication recovery; publication remains behind its existing
operator-controlled flag.

## Acceptance evidence

- Native skill intent tests cover compatible selection, exact pinning, revocation,
  changed artifacts, runtime input boundaries and subsequent reuse using explicit
  approval fixtures. This is not independent operational promotion.
- Skill outcome tests bind delivery receipts to immutable package identity and
  reject missing or contradictory verification verdicts.
- Executable skill and factory tests require canonical parent/run/task provenance,
  unchanged interfaces/dependencies and non-expanding tools; children are candidates.
- Approval continuation tests reject expired, foreign, stopped and cancelled work.
- Draft publication tests use isolated Git and mocked GitHub to recover a commit or
  accepted PR without duplicate publication, and reject stale ownership/artifacts.
- The operator-authored provider-step-usage package has runnable Node tests and
  retains unknown/error distinctions. It is not approved or activated.

## Limits and activation

No new scheduler, automatic CI repair, generalized mandate framework, agent factory
or swarm is introduced. Existing promotion/security/training/OpenMythos gates remain
unchanged. No automatic merge or production deployment. A real bounded factory
attempt exhausted its token budget without producing a package; provider creation,
independent promotion and subsequent approved runtime reuse remain unproven.
Rollback source through normal review; retain additive nullable outcome columns and
candidate history. Feature-off remains a valid release state.
