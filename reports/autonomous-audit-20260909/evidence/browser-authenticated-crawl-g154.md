# G154 — authenticated browser crawl and task execution

Date: 2026-09-10 (Europe/Amsterdam)

## Runtime

An isolated built server was started from the audit checkout on `127.0.0.1:3187` with a temporary SQLite database and temporary bootstrap admin. External Qdrant, Ollama and UAMS URLs were deliberately pointed at an unavailable local port so that provider absence could not be mistaken for product proof.

## Browser evidence

Playwright CLI authenticated as the temporary admin and traversed all 36 dashboard links exposed by the authenticated navigation:

`/`, `/tasks`, `/agents`, `/catalog`, `/swarm`, `/approvals`, `/policies`, `/governance`, `/compliance`, `/mcp-permissions`, `/observability`, `/audit`, `/repositories`, `/goals-loops`, `/fleet-cockpit`, `/usage`, `/workstation-urls`, `/economy`, `/federation`, `/swarm-resources`, `/swarm-mission-control`, `/interaction-board`, `/cognitive`, `/self-driving`, `/authority`, `/audit/logs`, `/pipeline-builder`, `/agi-reasoning`, `/consensus-debates`, `/predictive-analytics`, `/self-healing`, `/explainers`.

Every route returned its expected local URL and rendered an h1 or primary heading. Representative headings included `Mission Control`, `Tasks`, `Agents`, `Agent Catalog`, `Approval Queue`, `Goals & Loops`, `Cognitive Runtime`, `Self-Healing Dashboard` and `Daily Budget`.

The browser console contained only the known Playwright `data:,` CSP noise during navigation. On the final task-detail page there were no network or console errors after the route loaded. The temporary rapid crawl briefly hit the server's expected organizations rate limit (`429`); this did not affect route rendering or the subsequent task flow.

## End-to-end task proof

Through `/tasks` the browser opened `Create New Task`, filled title and description, selected `low` priority, `local` execution mode and `mock` runtime, and submitted the form. The task appeared in the list as `pending` with a durable task id.

Opening the task and pressing `Execute` produced a real `POST /api/tasks/:id/execute` (HTTP 200). The detail page observed `running`, then after reload observed `completed` and a populated execution timeline containing mock tool call/result events. Server logs also recorded the create (`POST /api/tasks`, HTTP 201), execute, detail/event/approval reads, and completion persistence.

The task's optional UAMS/Qdrant memory syncs failed with `fetch failed` because those external services were intentionally unavailable in this isolated fixture. The core task state and audit/timeline path completed; provider-backed memory synchronization remains explicitly unverified.

## Authority boundary

The `/authority` page rendered, but its `/api/authority/stats` request returned the designed `503 AUTHORITY_LEDGER_UNAVAILABLE` because a fresh instance has no provisioned `authority_events` ledger. This is fail-closed intentional unavailability, not a hidden success claim.

## Cleanup

The temporary server and database were stopped/removed after the probe; no production or external state was mutated.
