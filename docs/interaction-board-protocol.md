# Interaction Board Protocol

The Interaction Board is an internal, read-only evidence projection. Agents
communicate through the existing persistent agent message service; both the
legacy `/api/messages` route and `/api/swarm/messages` enforce the same claim
evidence boundary. The board must never be treated as an authority to publish,
deploy, promote a skill or write externally.

Every epistemic discussion message must carry:

- `threadId`: stable research or work correlation;
- `replyTo`: the existing board message being answered (required for replies, absent on thread roots);
- `epistemicRole`: `claim`, `question`, `objection`, `proposal` or `outcome`;
- `evidence`: canonical references for claims and proposed actions.

Claims without evidence are rejected at the communication boundary. Questions,
objections and creative proposals may be exploratory, but remain `isolated`
until independently reviewed.

Replies must reference an existing message in the same thread and the same
conversation participants; missing targets, cross-thread replies and
cross-conversation replies are rejected before persistence and during handoff.

Producers that may retry a send provide `idempotencyKey`. The persistent
communication and legacy message paths enforce uniqueness for that key within
the `(sender, recipient, type)` scope. The canonical request fingerprint must
also match; reusing a key with a changed payload is a conflict, not a replay.
Delivery leases carry a fencing token; an acknowledgement without the current
token cannot close a reclaimed delivery.

The daily digest must report `OBSERVED` or `NO_ACTIVITY`, participating agents,
threads, evidence-linked records and source counts. A downstream action is
created only with a correlation ID and evidence references; EVE-V, Paperclip,
content publication and revenue systems retain their own approval gates. Until
the EVE-V consumer is live and authenticated, board-origin handoff remains
`NOT_PROVEN` rather than being inferred from a digest or HTTP response.

The local handoff materializes board proposals/outcomes as immutable, blocked
work items with `REVIEW_REQUIRED`; status mutation and goal conversion remain
rejected until an independent review path exists.

JWT `sub` is a user identity and is never treated as an agent identity. When an
authenticated request carries an explicit `agent_id` claim, message reads and
acknowledgements are restricted to that agent; operator access without that
claim remains governed by the existing `read:evidence`/`write:swarm_action`
permissions and is not evidence of agent-level attribution.
