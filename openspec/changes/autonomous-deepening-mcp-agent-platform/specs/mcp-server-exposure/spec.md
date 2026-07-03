## ADDED Requirements

### Requirement: DjimFlo exposes loop orchestration via MCP
The system MUST provide MCP tools for starting, continuing, and querying loop runs.

#### Scenario: Start a loop via MCP
- **WHEN** an MCP client calls `djimitflo_start_loop` with a loop name and repository path
- **THEN** a new loop run is created and the run ID is returned

#### Scenario: Continue a loop via MCP
- **WHEN** an MCP client calls `djimitflo_continue_loop` with a run ID
- **THEN** maker and checker leases are prepared and lease details are returned

#### Scenario: Get loop status via MCP
- **WHEN** an MCP client calls `djimitflo_get_loop_status` with a run ID
- **THEN** the current run status, gates, and next actions are returned

### Requirement: DjimFlo exposes goal management via MCP
The system MUST provide MCP tools for creating and listing goals.

#### Scenario: Create a goal via MCP
- **WHEN** an MCP client calls `djimitflo_create_goal` with objective and acceptance criteria
- **THEN** a new goal is created and the goal ID is returned

#### Scenario: List goals via MCP
- **WHEN** an MCP client calls `djimitflo_list_goals`
- **THEN** all goals with their status and risk class are returned

### Requirement: MCP server supports stdio and HTTP transports
The system MUST support both stdio (local) and Streamable HTTP (remote) transports.

#### Scenario: Stdio transport works locally
- **WHEN** the MCP server is started with `--transport stdio`
- **THEN** it communicates over stdin/stdout using MCP JSON-RPC

#### Scenario: HTTP transport works remotely
- **WHEN** the MCP server is started with `--transport http --port 3002`
- **THEN** it serves MCP endpoints at `/mcp` and accepts Streamable HTTP requests
