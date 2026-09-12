# Independent execution-summary review

Scope: current evidence reader, shared wire types, dashboard review/API consumers and exports. No native runtime or production actions. Review fixtures use isolated in-memory SQLite and existing services.

## Concrete defects reproduced and corrected

1. **Historical approval aggregation obscured the current recorded decision.** Actual `EvidenceService` with a completed task, older denial and newer approval returned `approval_granted:false` and `approval_status:denied`. Adding an unrelated manual pending action to approved execution returned `pending`. The reader now retains sanitized decision history separately, chooses the newest nonmanual decision for the selected executor, and preserves pending execution HOLD precedence. Manual decisions do not become execution approval requirements. New fields identify the recorded approval ID and scope; no input-hash authorization verification is implied. Historical executor-unscoped decisions remain explicitly legacy recorded decisions rather than provider certification.
2. **New post-capacity policy evidence was not recognized by the summary.** An initial allow followed by the engine's actual `source:queue-admission`, `details.decision:deny` shape returned the earlier allow. This exact red test now passes after adding that canonical source to the reader. The shared source union is owned by the engine reviewer.

Evidence: `evidence-summary-approval-red.log` contains the reproduced historical-decision failure plus an initial manual-only fixture status typo (corrected to canonical `pending`, not a product defect). `evidence-summary-queue-admission-red.log` isolates the post-queue policy failure. `evidence-summary-approval-green.log` contains the final four-file regression rerun.

## Compatibility and proof boundaries checked

- `started_at` is truly nullable on the API. The existing NOT NULL materialization uses the documented empty-string sentinel; no inspected consumer parses that raw stored sentinel as an execution start. JSON exports use the current reader.
- Materialization updates preserve row ID and original creation time. Terminal task state is read freshly; task cancellation is not fabricated policy denial. Zero usage/duration stays zero.
- Normal execution-engine start events contain `metadata.executorKind`, so mock/CLI attempt attribution is available even when a runtime's own event uses another key. Requested configuration is labelled separately; neither configuration nor a fixture event proves provider execution.
- An assessment's nested recommendation is not treated as a captured policy decision. The summary is not enforcement, admission or per-attempt certification.
- Existing raw summary response and `{audit_trail}` envelope remain unchanged; reviewed API types and callers match those shapes. Access masking occurs before materialization. Export JSON exercises the same reader.
- Historical aggregate counters/events remain task-wide; the correction does not invent a per-attempt evidence model or rewrite immutable audit history.

## Verification

Final timeline correction: the browser exposed a synthetic grant projected onto an approval's earlier request timestamp. The reader now prefers canonical audit entries separately for request and decision stages; a legacy fallback is explicitly labelled and records a decision only when `decided_at`, `approved_at` or `denied_at` exists. A deadline alone is not evidence of when expiry was processed. Canonical request history remains unchanged after an actual local `ApprovalService` decision, without duplicate grant entries. Red evidence: `evidence-approval-timeline-red.log`. Final green evidence: `evidence-approval-timeline-green.log`, **87/87 across four files, 12 summary tests**, with server type check, scoped lint and diff check passing. Parent separately reports rebuilt browser proof of two canonical grants at their exact persisted decision timestamps and 13 trail entries; this note's directly executed proof remains the local service regression.

The final focused run passed **85/85 tests across four files**, including **10 summary regressions**: `evidence-summary-continuation.test.ts`, `export.test.ts`, `spec-compliance-export.test.ts` and `execution-engine.test.ts` (17:34 local, 13.33 seconds). Scoped ESLint and `git diff --check` passed. The first server type check exposed the concurrently added `queue-admission` source missing from the shared union; after its owner added the declared source, an independent server type-check rerun exited zero. Parent owns final integrated type/build/browser evidence.
