# Native mediation boundary — read-only reconstruction

G10 remains DISCONNECTED. The engine constructs ToolBroker, but production executors do not call evaluate/validate at tool-effect boundaries. Seven CLI adapters use closed stdin and parse events after execution. A task-start approval is not approval of every internal tool call. G77 separately closes principal replay for durable broker tokens; it does not change the external CLI boundary.

Installed Codex0.153.4 exposes the bidirectional app-server protocol. Host-owned dynamic tools provide a concrete pre-effect boundary; requestApproval covers the native approval requests actually emitted, not every internal operation. Existing CodexExecutor, ApprovalService, engine sessions and lease lifecycle could be reused for a selected capability. No such transport was implemented in this tranche. [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)

Hooks cannot justify universal mediation: hosted tools are excluded, write_stdin input is not rechecked, specialized paths can opt out and some malformed PreToolUse outputs continue execution. No hook-based universal-enforcement claim is made. [Official hook documentation](https://learn.chatgpt.com/docs/hooks)

Before a host-owned effect may execute, the existing broker token contract would also need binding to server-derived principal, task, session, request identity and exact arguments, plus one-use/revocation enforcement. Current validation binds only token/tool/task/expiry; the method named violatesSeparationOfDuties uses a prior-decision count, not actual maker/checker/approver identity. Unit tests of that heuristic are not role-separation proof.

The open product decision is whether native tools remain delegated to the runtime sandbox with explicit limited broker coverage, or mediated tasks must exclusively use DjimFlo-owned tools. The latter changes the allowed execution surface and needs an explicit choice. A nonblocking user question was raised; no silent restriction, parallel control plane, provider call or credential change was made.

Required future proof for any chosen mediated effect: deny/timeout/revocation/changed arguments produce zero handler calls; approved exact request produces one effect; replay produces no second mutation; cancellation and restart cannot release an unknown in-flight effect. Selected-tool proof must not be relabeled universal enforcement.
