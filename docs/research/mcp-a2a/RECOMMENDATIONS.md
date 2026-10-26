# Recommendations: MCP, A2A, skills, memory and git tooling for Djimitflo

Ranked by **evidence × impact ÷ effort**. Risk and reversibility break ties.

- **Evidence:** V = verified in code, prod data or a primary source; D = vendor documentation; I = inferred.
- **Effort:** XS < 1 h, S ≤ 1 d, M ≤ 1 wk.

Sources are the five companion files: ARTICLE_SERVERS.md, OUR_SURFACE.md, A2A.md, SECURITY_GAPS.md and DISCOVERY.md.

**Headline.** None of the article's 10 MCP servers should be adopted. A2A is **DEFER**. The largest risks and gains sit in Djimitflo itself, in four places:
- makers share the server's container and uid (S0);
- the fleet bus and the agent registry are unauthenticated (S3);
- three MCP and HTTP write doors were wider than their API twins (S1, S2, S4; fixed in this PR);
- the settlement oracle cannot fail (G2). Stryker, which is already pinned, can fix that without a new dependency.

## Ranked list

| Rank | Recommendation | Gap / finding | Evidence | Impact | Effort | Risk | Reversible | What the operator must do |
|---|---|---|---|---|---|---|---|---|
| 1 | **Merge this PR.** MCP catalog writers need `manage:config`; `explainer_create_task`/`run_task` need `write:governance`; `POST /api/knowledge/publish` needs `write:claim`. | S1, S2, S4 | V (tests fail on main) | M: the MCP door is no wider than the API | XS | low (all prod users are admin, so nothing changes today) | yes (revert) | Review and merge. No flag, no deploy step beyond the normal train. |
| 2 | **Isolate makers from the control plane** before any untrusted input reaches them. Concretely: a separate uid, only the lease worktree visible, `/data` not readable, and egress limited to the model endpoints. | S0 (BLOCKING for G4.3 and for any new maker MCP, A2A peer or skill) | V (uid 1001 owns the prod DB; 4,329 maker bash calls in 30 d; no docker sandbox in the container) | H: precondition for external repos and every adoption below | M | medium (maker runtime change; the gym on the workstation can shadow first) | yes | Approve the design (G4.2 threat model). Root changes on the VPS image/host are per-command approvals, per the charter. |
| 3 | **Authenticate the event bus and the agent registry.** Bearer token on bus POST/GET (the outbox already sends `DJIMIT_EVENT_BUS_TOKEN`); token on every non-GET registry route (`/memory/*`, `/context/forward`, `/knowledge/agent/*/register`); Djimitflo ingest sends the token; extend `FLEET_EVENT_SIGNATURES` to `roborev.*` and `outcome.*` before they create work. Then sign the registry cards (A2A-2). | S3 (BLOCKING for G5.1), A2A-1/2 | V (no auth in `/srv/event-bus/main.py` or `/srv/agent-registry/main.py`; 9,679 events in 30 d from 8 self-declared sources) | H: fleet value and roborev findings become trustworthy | S | low–medium (every publisher needs the token; roll out in shadow: log unauthenticated, then refuse) | yes | Provision the token on all 7 hosts. Deploy the two `/srv` services (root-owned). Decide the cut-over date. |
| 4 | **Make the settlement endpoint executed.** Use the already-pinned StrykerJS 10 line-range `--mutate` plus `killedBy`: at day 14, re-run mutation on the merged test and count the mutants only that test kills. A change with 0 new kills becomes "verified-ineffective". | G2 (22/22 survived; 26/64 kill 0 mutants) | V (Stryker report schema; `scripts/mutation-gain.mjs`), I (design) | H: Gate B and the north star can discriminate again | S–M | low (shadow first) | yes | Approve a pre-registered amendment to R2/Gate B. Nothing to install. |
| 5 | **Deterministic finding supply for the finding-fix lane.** Opengrep v1.31.0 (cosign-verified binary) with a small curated TS/JS rule pack, plus osv-scanner v2.7.0 **CLI** `--offline` against a pinned DB snapshot. Never their MCP modes. Never Semgrep registry rules (licence, telemetry). | G1 | V (pins, telemetry code, offline flags), D (FP rates unknown) | M–H: a second executed task type on more repos | M | low (read-only scanners, offline) | yes | Approve two pinned binaries on the workstation (not prod) and the rule pack. Approve the osv DB snapshot pull as a new outbound target **from the workstation**. |
| 6 | **Remove the dead MCP from prod makers.** Delete or disable `mcp.djimitflo` in `/srv/djimitflo/opencode.json`. | S13 | V (0 MCP calls among 6,716 tool calls in 555 logs, 30 d) | L–M: less latent surface | XS | none | yes | Edit the root-owned host file. |
| 7 | **Least-role service accounts.** Today all 4 prod users are `admin`. Give the gym bridge, PR-review webhook, dashboards and MCP clients their own maker / checker / viewer accounts, then rotate their tokens. | S12 | V | M: every permission check, including this PR's, starts to mean something | S | low | yes | Create the accounts and rotate the tokens (`manage:users`). |
| 8 | **Make the `/mcp-permissions` page honest.** First label it "catalog only, not enforced" and validate `decision ∈ {allowed, requires_approval, denied}`. Later, optionally enforce the decisions in the djimitflo MCP server (refuse `denied`; require an approved `approvals` row for `requires_approval`). | S5 | V (no reader of `mcp_tool_permissions` outside display; 147/148 rows synced) | M: no false sense of control | XS (label) / S (enforce) | none / low | yes | Choose (b) label-only, or (a) enforce. |
| 9 | **Machine-promoted memory stays out of maker prompts.** `assignment-context` reads only rules with `approver_type: human` (L3 P0-9). | S14 | V | M: closes the memory-poisoning path into `LOOP_WORK.md` | S | low (the memory holdout reads out 27-10; align with G3.3) | yes | OK to change memory injection. It touches the running memory holdout, so decide after the 27-10 readout. |
| 10 | **Failure-cause vocabulary.** Adopt the OTel GenAI `error.type` closed enum (`env.*`, `reviewer.*`, `maker.*`, `oracle.*`, `cancel.*`) on every lease close, with the cancel reason NOT NULL. Optional OTLP from Claude Code / Codex to a local receiver route. Turn off Codex default analytics. | G3 | V (spec), I (design) | M: denoises about 44 % of non-verified outcomes | M | low | yes | None for the vocabulary. Maker-host env changes to enable runtime telemetry or disable Codex analytics. |
| 11 | **Confine the NotebookLM tools.** `add_source type=file` and `download outputPath` restricted to `NOTEBOOKLM_FILE_ROOT`. Mutating notebook tools behind `NOTEBOOK_MCP_WRITE=on` (default off). | S6 | V | M on the operator laptop | S | low (changes your workflow) | yes | Say which directory NotebookLM may read and write. |
| 12 | **Harden MCP HTTP before it is ever deployed.** Bind 127.0.0.1; accept only `aud: djimitflo-mcp` tokens; Origin check; rate limiter; Streamable HTTP instead of legacy SSE. | S7 | V | M (latent today) | S | low | yes | None until you want fleet MCP over HTTP. Then approve the token-minting change. |
| 13 | **Small hygiene.** One tool registry (`index.ts` uses `register-tools.ts`); `readOnlyHint` / `destructiveHint` on all 60 tools; pin `@playwright/mcp@<version>` in `.vscode/mcp.json`; run the local MCP server from a pinned built copy, not the shared checkout's `dist/`; hash-pin installed OKF skills; `https://` for the arXiv fetch in `dream_cycle.py`; `human_approval_ref` must resolve to an approved `approvals` row (S17); `manage:config` on segml `/receive` (S19). | S9, S10, S11, S16, S17, S19 | V | L–M each | XS–S each | none | yes | Pick the Playwright version. Move your local `.mcp.json` to the pinned copy. |
| 14 | **TypeScript 7 LSP as read-only maker tools**, wrapped in our own MCP server (definition, references, symbols, diagnostics; scoped to the worktree; killed at lease end). | G6 | D | M for second repos | M | medium (new maker input) | yes | **Only after #2 and #6**, once makers actually use MCP. Otherwise DEFER. |
| 15 | **A2A: DEFER.** No caller needs it, and its push model conflicts with the pull-only rule. Take A2A-3 now: a federation peer must not need an admin token on the receiver. Reopen if a named external counterparty must call us agent-to-agent; then build a signed-card, server-side facade only, behind a flag. | A2A.md | V | — | — | — | — | Name the counterparty if one appears (G4.3). |
| 16 | **Article servers: adopt none.** Add a canonical-repo check (owner type, fork-of, ahead/behind, package name matches repo) to the scout and Frontier discovery records. The article linked 2 of 10 non-canonical repos. | ARTICLE_SERVERS.md | V | L | XS | none | yes | None. |

## Explicitly not recommended

| Item | Reason |
|---|---|
| Any of the 10 article servers | ARTICLE_SERVERS.md. Four of them send telemetry by default. DBHub's read-only mode was bypassed three times in 2026. Blender's tool is `exec()` on an unauthenticated socket. Snyk uploads source code. |
| github/github-mcp-server for makers | No gap needs it. Releases are too fast to pin calmly (4 in 15 days). Lockdown mode "is not an authorization boundary". |
| Serena, `mcp-server-git`, Semgrep MCP, gitsign | DISCOVERY.md "Checked and rejected" |
| GitHub merge queue | The repo is owned by a User, and merge queue needs an organisation. Head-SHA binding already exists (#914). |
| ruvnet packages and hooks | NE-009 / NE-012 stand. Nothing here reopens them. |

## No negative-evidence entry proposed

Nothing here was a falsified hypothesis tested on Djimitflo data. The article servers are rejected on design and fit grounds, which the standing rule against community MCP servers already covers (NE-008 `why`). If the operator wants a registry trace, the precedent is NE-011 (an org-level REJECT, documentation only). An NE-013 "10 article MCP servers" entry could be added on request.
