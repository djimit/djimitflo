## ADDED Requirements

### Requirement: Consensus debates support real-time streaming
The system MUST stream consensus debate events to connected WebSocket clients.

#### Scenario: Client subscribes to debate
- **WHEN** a WebSocket client connects to `/ws/consensus/:debateId`
- **THEN** they receive all subsequent events for that debate

#### Scenario: Proposal is broadcast in real-time
- **WHEN** an agent submits a proposal via HTTP POST
- **THEN** all subscribed WebSocket clients receive the proposal immediately

#### Scenario: Vote updates are streamed
- **WHEN** an agent casts a vote
- **THEN** all subscribed clients receive the updated proposal scores

#### Scenario: Disconnected clients catch up on reconnect
- **WHEN** a WebSocket client reconnects after disconnection
- **THEN** they receive all missed events since their last connection

### Requirement: WebSocket connections are managed safely
The system MUST limit WebSocket connections and handle disconnections gracefully.

#### Scenario: Connection limit is enforced
- **WHEN** more than 100 concurrent WebSocket connections attempt to connect
- **THEN** additional connections are rejected with a 429 status

#### Scenario: Stale connections are cleaned up
- **WHEN** a WebSocket connection is inactive for >5 minutes
- **THEN** the server closes the connection and frees resources
