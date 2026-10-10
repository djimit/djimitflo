# REA — feasibility and security assessment

**Decision: NO_GO for integration (MCP server, agent setup, skill); DEFER for any offline use.** Confidence: high.

Read-only review of public metadata only; nothing installed or run.

## Identification

| Field | Value |
|---|---|
| Project | REA, "Reverse Engineer Anything" — github.com/morluto/rea (upstream; the search results also list several forks) |
| Commit reviewed | d1e6fe2e (package `rea-agents` 6.3.0) |
| Licence | MIT |
| Form | npm CLI + MCP server + agent skill; setup edits the agent's configuration and installs workflow instructions |
| Scope it claims | native binaries (through Hopper / Ghidra / IDA), JS/Electron, .NET, Android, firmware, websites, process behaviour |
| Its own guidance | its skill says to skip REA for ordinary analysis of a complete source repository |

## Fit for DjimitFlo

- Every runtime DjimitFlo admits (claude-code, codex, opencode, atomic) ships as an npm package or bundle whose files
  the existing shipped-code scan already inventories, hashes and diffs per release without executing anything.
- No current decision depends on deeper analysis of a closed-source executable. ACE's measured bottleneck is the
  benchmark (no headroom, exhausted holdouts, gym not predicting production), not missing insight into external
  software.
- Reimplementing features observed in other vendors' closed-source applications is outside DjimitFlo's scope and
  carries licence and terms-of-use risk that is an operator and legal matter, not an engineering one.

## Security findings

| Finding | Source | Impact |
|---|---|---|
| Not a sandbox; analysis runs with the user's permissions | its SECURITY.md | an untrusted target is parsed by local tools with full user rights |
| Runtime capture runs or interacts with the target | README | executing third-party binaries on a fleet host |
| Setup edits agent config and installs an MCP server + skill | README, AGENTS.md | violates the standing rule: no community MCP servers, hooks or skills |
| Docs steer to `npx rea-agents@latest` and frequent updates | README | unpinned supply chain on every run |
| Optional installer may escalate to root via `pkexec` | its SECURITY.md | root actions need per-command operator approval |
| Skill states no per-call approval is required | its skill file | bypasses DjimitFlo's approval model if wired into a maker |
| Large dependency surface (playwright-core, node-pty, isomorphic-git, MCP client/server …) | package.json | widens the runtime image's attack surface |

## Relation to the ruDevolution NO_GO (docs/research/rudevolution/)

Same capability class (analysing shipped code) and the same answer: the gap is already covered by the parse-only
shipped-code scan, and an agent-driven tool with execution rights, unpinned updates and its own MCP/skill install path
does not meet DjimitFlo's trust boundary. REA is better documented than ruDevolution, but the governing reasons are
policy and fit, not quality.

## Revisit only if

A concrete supply-chain question arises that the shipped-code scan cannot answer — e.g. a release diff flags a changed
native binary in an admitted runtime with no upstream explanation — and the operator approves an isolated, offline,
pinned, network-less analysis host for that one question. Until then nothing is installed.
