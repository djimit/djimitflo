# Implementation Plan: Agent Catalog Dashboard Page

**Branch**: `001-agent-catalog-page` | **Date**: 2026-06-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-agent-catalog-page/spec.md`

## Summary

Add an Agent Catalog page to the djimitflo dashboard that displays imported
agents in a filterable, searchable table with summary counts. Admins can
activate/deactivate agents. The server API (`/api/catalog/*`) already exists;
this feature is dashboard-only.

## Technical Context

**Language/Version**: TypeScript 5.x, React 19, Vite

**Primary Dependencies**: react-router-dom, zustand, tailwindcss, @djimitflo/shared

**Storage**: N/A (dashboard reads from existing server API)

**Testing**: Vitest

**Target Platform**: Browser (dashboard SPA)

**Project Type**: web-app (dashboard workspace of monorepo)

**Performance Goals**: Page load <1s for 100 agents, search filter <300ms

**Constraints**: Must use existing API client pattern, existing auth store, existing layout component

**Scale/Scope**: Up to 100 agents in catalog, single page with table + filters

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [X] **Test-First**: Tests will be written before implementation (Vitest)
- [X] **Simplicity**: Single page component, no new packages, no new abstractions
- [X] **Anti-Abstraction**: Uses existing API client, auth store, and layout directly
- [X] **Monorepo Discipline**: Feature only touches `@djimitflo/dashboard` package
- [X] **ESM and TypeScript Strict**: All new code uses ESM + strict types

## Project Structure

### Documentation (this feature)

```text
specs/001-agent-catalog-page/
├── spec.md
├── plan.md
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/dashboard/
├── src/
│   ├── pages/
│   │   └── AgentCatalogPage.tsx       # NEW — main catalog page
│   ├── components/
│   │   └── AgentCatalogTable.tsx      # NEW — table with filter/search
│   ├── hooks/
│   │   └── useCatalog.ts             # NEW — data fetching hook
│   ├── lib/
│   │   └── api.ts                     # MODIFIED — add catalog API methods
│   └── App.tsx                        # MODIFIED — add route
└── tests/
    └── AgentCatalogPage.test.tsx      # NEW — page tests
```

**Structure Decision**: Single-page component with a extracted table component for
testability. A custom hook (`useCatalog`) encapsulates data fetching and state.
No new packages. Follows existing patterns (e.g., `AgentsPage.tsx`, `useStore`).

## Implementation Phases

### Phase 0: API Client Extension

Add catalog API methods to the existing `api.ts` client:
- `getCatalogCounts()` → `GET /api/catalog/counts`
- `getCatalogAgents(params?)` → `GET /api/catalog/agents?division=&status=`
- `searchCatalogAgents(q, topK?)` → `GET /api/catalog/search?q=&topK=`
- `activateAgent(id, target?)` → `POST /api/catalog/activate/:id`
- `deactivateAgent(id)` → `POST /api/catalog/deactivate/:id`

### Phase 1: Data Hook

Create `useCatalog` hook using zustand or local state:
- Fetches counts and agents on mount
- Manages loading, error, and retry states
- Exposes filter/search/activate/deactivate actions

### Phase 2: Table Component

Create `AgentCatalogTable` component:
- Columns: name, division, status (badge), evaluation score
- Division filter dropdown
- Search input (debounced 300ms)
- Row-level activate/deactivate buttons (permission-gated)

### Phase 3: Page Assembly

Create `AgentCatalogPage`:
- Summary counts row at top (4 stat cards)
- Table component below
- Empty state and error state handling
- Add route to `App.tsx`: `<Route path="catalog" element={<AgentCatalogPage />} />`
- Add NavLink to `Layout.tsx`

### Phase 4: Testing

Vitest tests covering:
- Page renders with agents
- Empty state when no agents
- Error state with retry
- Filter by division
- Search by name
- Activate/deactivate (permission-gated)

## Complexity Tracking

No constitution violations. Feature is a single dashboard page using existing patterns.

---

## Security Impact

The catalog page exposes existing API endpoints in the UI. No new endpoints are
created. The activate/deactivate actions are already permission-gated server-side
(`manage:config`). The dashboard must also gate these buttons client-side using
`useAuthStore.hasPermission('manage:config')`.

No new attack surface — the page only reads from existing authenticated endpoints
and calls existing permission-protected mutations.

## Privacy Impact

No new user or engagement data is generated. The catalog page displays agent
metadata (name, division, status, evaluation) that is already accessible via the
existing API. No PII is involved.

No new data exposure — the page surfaces existing data through existing
authenticated, permission-protected endpoints.

## Threat Model Delta

| Vector | Mitigation |
|--------|------------|
| Client-side permission bypass (buttons visible to non-admins) | `useAuthStore.hasPermission('manage:config')` gates button visibility; server-side `requirePermission('manage:config')` is the authoritative gate |

No new threat model delta — the page operates within existing trust boundaries
and the server-side permission check is authoritative.

## Rollback Strategy

- **Code rollback**: `git revert <commit> && git clean -fd`
- **Data rollback**: N/A (no data changes — dashboard-only feature)
- **Config rollback**: N/A (no config changes)
- **Full rollback command**: `git checkout -- . && git clean -fd`
