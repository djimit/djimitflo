---
type: architecture
title: Dashboard Frontend Architecture
description: How the Djimitflo dashboard (React 19 + Vite + Tailwind) is bootstrapped, authenticated, and kept live via a single HTTP client and a WebSocket event stream, and how its pages are organized.
tags: [dashboard, frontend, react, vite, websocket, auth, zustand]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-19T12:23:47.840Z
---

## Overview

The dashboard is a single-page React 19 application built with Vite and Tailwind CSS 4, living in `packages/dashboard`. It renders a real-time control plane for tasks, agents, swarm loops, governance, and fleet operations. Four pieces anchor the architecture:

- `src/App.tsx` — router shell, route table, and initial data load.
- `src/lib/api.ts` — the single HTTP client (`ApiClient`) that every page and component uses to talk to the backend.
- `src/lib/auth-store.ts` — the Zustand-backed session/token store plus the shared `authenticatedFetch`/`apiRequest` fetch wrapper.
- `src/hooks/useWebSocket.ts` — the low-level WebSocket connection hook, wrapped by `src/components/WebSocketProvider.tsx` for app-wide event fan-out.

State that needs to be shared across pages (tasks, agents, connection status, system health) lives in a second, simpler Zustand store, `src/lib/store.ts`, which is populated by the initial REST load and kept current by WebSocket events.

## Application shell and routing (`App.tsx`)

`App()` wraps the whole tree in a `GlobalErrorBoundary`, then a `BrowserRouter`. On mount it calls `useAuthStore().restoreSession()` once to attempt silent session recovery (see below) before routes render.

Routing structure:

- `/login` renders `LoginPage` outside of any auth gate.
- `/` and all nested routes are wrapped in `ProtectedRoute`, which reads `isAuthenticated`/`isLoading` from the auth store: while `isLoading` it shows a loading placeholder, when unauthenticated it redirects to `/login` via `Navigate`, otherwise it renders its children.
- Inside the protected branch, `WebSocketProvider` establishes the live event subscription, `DataLoader` performs the one-time initial REST fetch of tasks and agents into the shared store, and `Layout` renders the sidebar/shell with a `<Outlet />` for the nested page routes.
- Most page components are dynamically imported with `React.lazy` and rendered behind a single top-level `<Suspense>` fallback, so route code-splitting does not require per-route loading UI.

`DataLoader` calls `api.getTasks()` and `api.getAgents()` in parallel on mount and seeds `useStore()` with the results; WebSocket events subsequently keep this store in sync (see WebSocketProvider below). Failures during this initial load are caught and logged but do not block rendering — pages then rely on incremental WebSocket updates and their own fetches.

## HTTP client (`lib/api.ts`)

`api.ts` exports a singleton `ApiClient` instance (`export const api = new ApiClient()`) that is the single point of contact for backend REST calls across the dashboard: task/agent CRUD and execution, approvals and policies, MCP permissions, observability, audit, repositories, goals/loops, swarm reality/resource/topology queries, governance scorecards, usage/economy, pipeline builder, federation, and more. Its private `request<T>()` method is the shared low-level entrypoint: it delegates to `authenticatedFetch` from `lib/auth-store.ts`, maps HTTP `403`/`404` to typed errors, and otherwise parses the JSON body or throws using the server's `message`/`error.message`.

Because every typed method (`getTasks`, `createTask`, `executeTask`, `getRuntimeGovernanceAgent`, `getMetaTuningHistory`, generic `get`/`post`, and dozens more) funnels through this one `request` method, authentication, retry-on-expiry, and error normalization are handled in exactly one place rather than being duplicated per page. `api.ts` re-exports `API_BASE` from `auth-store.ts` so callers needing raw `fetch` (e.g. for downloads or streaming) share the same base URL resolution.

## Auth store and session handling (`lib/auth-store.ts`)

`useAuthStore` (Zustand) holds `{ user, token, isAuthenticated, isLoading, error }` plus the actions `login`, `logout`, `restoreSession`, `replaceToken`, and `hasPermission`. Key mechanisms:

- **Access token storage.** The bearer token is persisted in `localStorage` under `AUTH_SESSION_KEY` (`djimitflo_auth_session`). `API_BASE` resolves to `/api` in production or `VITE_API_BASE` (default `/api`) in development, matching the Vite dev-server proxy.
- **Browser-session cookie opt-in.** All auth endpoint calls (`login`, `refresh`, `logout`) go through `browserAuthRequest`, which sends `credentials: 'include'` and sets the header `X-Djimitflo-Session: browser`. This header is a backend-driven contract — the server (`packages/server/src/routes/auth.ts`) uses it to decide whether to treat the request as a browser session eligible for an httpOnly refresh cookie, not a frontend security boundary in itself; the dashboard simply opts in on every auth call so the server can issue/consume that cookie. Refresh cookies are never read from JavaScript.
- **Refresh flow.** `refreshSession()` is a de-duplicated ("singleflight") async operation: concurrent callers share one in-flight promise (`refreshFlight`), and when the Web Locks API is available (`navigator.locks`) the actual network round trip is additionally serialized across browser tabs via `withSessionLock`, so at most one tab performs a refresh at a time. It re-checks a monotonically increasing `sessionEpoch` and an explicit `loggedOut` flag at each await boundary to detect concurrent logout/session changes and abort stale work; a `sameSessionScope` check compares JWT `sub`/`sid`/`organization_id` claims so a session swapped in from another tab is only reused when its scope matches.
- **Authenticated fetch with single retry.** `authenticatedFetch()` is the shared boundary used by both `apiRequest` (JSON) and `ApiClient.request` (typed API calls): it sends the current bearer token, and on a `401` response performs exactly one `refreshSession` + retry; a second `401` clears the session and throws. This bounds retry loops to one refresh attempt per request.
- **Cross-tab coordination.** A `window` `storage` event listener reacts to other tabs changing/clearing `AUTH_SESSION_KEY`: it bumps `sessionEpoch` on logout or scope change, updates `isAuthenticated`/`user`/`token` in the store, and forces a full page reload when the session's organization/subject/session-id scope actually changed (as opposed to a same-scope token rotation), avoiding stale in-memory state after an organization switch.
- **Session restore.** `restoreSession()` (called once from `App`) attempts silent recovery: if there is no access token it calls `refreshSession(null)` to try exchanging a refresh cookie for one, then calls `GET /auth/me`; a first-time anonymous visitor's expected 401 is treated as a quiet non-error rather than surfaced to the login screen.
- **Permissions.** `hasPermission(permission)` looks up the current user's role in `ROLE_PERMISSIONS` (from `@djimitflo/shared`) and checks membership, giving pages a single call to gate UI on RBAC without re-deriving role logic locally.

## Live event stream (`hooks/useWebSocket.ts` + `WebSocketProvider`)

`useWebSocket(isAuthenticated)` owns the raw `WebSocket` lifecycle:

- **Connection target.** In development it prefers `VITE_WS_URL`; otherwise it derives `ws(s)://<host>/ws` from `window.location`, matching the Vite dev proxy's `/ws` WebSocket passthrough to the backend (`vite.config.ts`).
- **Authentication via subprotocol.** The socket is opened with a WebSocket subprotocol of the form `bearer.<token>` (e.g. `new WebSocket(WS_BASE_URL, \`bearer.${token}\`)`) instead of a query string, so the JWT is not exposed in access logs, browser history, or `Referer` headers. Validating this subprotocol and extracting/authenticating the token is the backend's responsibility (`packages/server/src/services/websocket-service.ts` and related server code) — it is a server-enforced security boundary that the dashboard simply participates in by using the subprotocol handshake correctly, not a mechanism the frontend can rely on for its own auth guarantees.
- **Reconnection and auth-failure handling.** Non-auth closes trigger an automatic reconnect after 3 seconds while the hook remains "enabled". Auth-related close codes (`AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_EXPIRED` from `WS_CLOSE_CODES`, shared via `@djimitflo/shared`) stop automatic reconnection; specifically, `AUTH_EXPIRED` triggers exactly one `refreshSession` attempt (guarded by `authRefreshUsed`) before retrying the connection, while other auth failures leave the socket closed until the enclosing `isAuthenticated`/token state changes.
- **Message dispatch.** Incoming JSON messages are dispatched to handlers registered via `subscribe(eventType | 'all', handler)`; a batched envelope (`type: 'execution.batch'` with a `payload.events` array) is unrolled so each contained event still reaches per-type and `'all'` subscribers individually.
- **Enable/disable driven by auth.** An effect keyed on `isAuthenticated` (and the current token) enables/connects or fully disconnects the socket, so the live stream only exists while a user session is active.

`WebSocketProvider` is the app-wide consumer of this hook: it subscribes to task and agent lifecycle events (`TASK_CREATED/UPDATED/DELETED/STARTED/COMPLETED/FAILED`, `AGENT_UPDATED`, `AGENT_STATUS_CHANGED`) and `SYSTEM_HEALTH`, and applies them to the shared `useStore()` (tasks/agents/system health/connection flag), wrapping each handler in a defensive try/catch so a malformed event cannot crash the app. It also mirrors `isConnected` from the hook into the store so pages can show connection status without depending on the hook directly.

## Page catalog

`App.tsx`'s route table organizes roughly forty page components; rather than enumerate every route, the major functional groups are:

- **Tasks / Approvals** — `TasksPage`, `TaskDetailPage`, `ReviewPage`, `ApprovalQueuePage`, `PolicyCenterPage`: task CRUD/execution, human-in-the-loop approval decisions, and execution policy configuration.
- **Swarm Mission Control** — `SwarmOverviewPage`, `SwarmMissionControlPage`, `SwarmResourcesPage`, `GoalsLoopsPage`, `ProofRunDetailPage`: live views over swarm reality (agents, worker leases, loop runs), goal/loop orchestration, resource pools, and individual proof-run detail drill-downs.
- **Fleet Cockpit** — `FleetCockpitPage`, `AgentCatalogPage`, `AgentsPage`, `AgentCommonsPage`, `WorkstationUrlsPage`: fleet-wide agent/runtime capacity, catalog and per-agent detail, and workstation/runtime endpoints.
- **Governance Scorecard** — `GovernanceScorecardPage`, `CompliancePage`, `AuditPage`, `AuditLogViewer`, `AuthorityTracePage`, `MCPPermissionsPage`: certification/quarantine status, assurance/SDD compliance, audit trails, and MCP tool permission management.
- **Explainer Fleet** — `pages/explore/ExplainerFleetPage` (lazy-loaded from the `explore` subdirectory) together with related exploratory/analytics pages such as `AgiReasoningPage`, `ConsensusDebatePage`, `PredictiveAnalyticsPage`, `SelfHealingPage`, `CognitiveRuntimePage`, and `SelfDrivingDashboard`: higher-level reasoning/explainability and predictive views layered on top of the same task/agent/event data.

Other standalone routes cover observability metrics, repositories and repository health, usage/cost accounting, the economy view, a visual pipeline builder, and federation. The sidebar (`components/Layout.tsx`) mirrors this route set with icons and active-state highlighting, and gates the visible items on the authenticated user via `useAuthStore`.

## Configuration and build (`vite.config.ts`)

- Plugins: `@vitejs/plugin-react` and `@tailwindcss/vite` (Tailwind CSS 4's native Vite integration, no separate PostCSS config path needed for Tailwind itself).
- Path aliases: `@` → `src`, and `@djimitflo/shared` → the sibling `packages/shared/src`, so the dashboard consumes shared types (tasks, agents, WebSocket events, RBAC permissions) directly from source in the monorepo.
- Dev server proxy: `/api` → `http://localhost:3001` and `/ws` → `ws://localhost:3001` (with `ws: true`), so the dashboard dev server and the backend API/WebSocket server run on separate ports without CORS/subprotocol friction during local development.
- `VITE_APP_VERSION` is injected at build/define time from `npm_package_version` (fallback `0.5.8`), and `VITEST` runs force `VITE_API_BASE` to `/api` for deterministic tests.
- Build target is `esnext` with sourcemaps disabled; Vitest runs in a `jsdom` environment with `globals: true`.

## Failure modes and invariants

- A page can never observe an "authenticated but tokenless" state for long: `isAuthenticated` and `token` are updated together in the auth store, and the WebSocket hook independently disconnects whenever `isAuthenticated` goes false.
- HTTP requests retry an expired bearer at most once (`authenticatedFetch`); WebSocket auth-expiry retries at most once per connection attempt (`authRefreshUsed`). Neither path can create an unbounded refresh loop.
- Refresh/login/logout each serialize through a single in-flight promise plus (when supported) a cross-tab Web Lock, preventing duplicate refresh-token rotations racing each other from multiple tabs.
- WebSocket reconnection only happens for non-auth closes while the hook is "enabled"; an explicit `disconnect()` (e.g. on logout) clears the pending reconnect timer so a stale timer cannot resurrect a connection after logout.
