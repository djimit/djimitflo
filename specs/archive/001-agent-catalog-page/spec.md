---
status: implemented
implemented_date: 2026-06-22
ratified_by: swarm-execution
lifecycle_state: implemented
---

# Feature Specification: Agent Catalog Dashboard Page

**Feature Branch**: `001-agent-catalog-page`

**Created**: 2026-06-22

**Status**: Implemented

**Input**: User description: "Add an Agent Catalog page to the dashboard that displays imported agents, their evaluation status, and allows activation/deactivation. The server API already exists at /api/catalog/*."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Agent Catalog (Priority: P1)

As an operator, I want to see a list of all imported agents with their evaluation
status and division so I can understand what agents are available in the system.

**Why this priority**: The catalog overview is the primary entry point — without
it, operators cannot discover or manage agents. Everything else depends on this
view existing.

**Independent Test**: Navigate to the Agent Catalog page and verify a table of
agents is displayed with columns for name, division, status, and evaluation score.

**Acceptance Scenarios**:

1. **Given** the server has imported agents, **When** the operator navigates to
   the Agent Catalog page, **Then** a table displays all agents with name,
   division, status, and evaluation columns.
2. **Given** the server has no imported agents, **When** the operator navigates
   to the Agent Catalog page, **Then** an empty state message is displayed:
   "No agents imported yet."
3. **Given** the operator is not authenticated, **When** they navigate to the
   Agent Catalog page, **Then** they are redirected to the login page.

---

### User Story 2 - Filter and Search Agents (Priority: P2)

As an operator, I want to filter agents by division and status, and search by
name, so I can quickly find specific agents in a large catalog.

**Why this priority**: Search and filter become necessary once the catalog grows
beyond a screenful. Not critical for MVP but essential for usability at scale.

**Independent Test**: Enter a search query and verify the table filters to
matching agents. Select a division filter and verify only agents in that division
are shown.

**Acceptance Scenarios**:

1. **Given** the catalog has agents in multiple divisions, **When** the operator
   selects a division filter, **Then** only agents in that division are displayed.
2. **Given** the operator types a search query, **When** the query matches an
   agent name, **Then** only matching agents are displayed.
3. **Given** the operator clears all filters, **When** the filters are reset,
   **Then** the full agent list is restored.

---

### User Story 3 - Activate and Deactivate Agents (Priority: P3)

As an admin, I want to activate or deactivate an agent from the catalog page so
I can control which agents are available for execution.

**Why this priority**: Activation management is the key administrative action on
the catalog. Less critical than viewing but necessary for operational control.

**Independent Test**: Click the activate button on a deactivated agent and verify
its status changes to active. Click deactivate on an active agent and verify its
status changes to inactive.

**Acceptance Scenarios**:

1. **Given** an agent is in "imported" status, **When** an admin clicks
   "Activate", **Then** the agent's status changes to "active" and a success
   toast is displayed.
2. **Given** an agent is in "active" status, **When** an admin clicks
   "Deactivate", **Then** the agent's status changes to "inactive" and a success
   toast is displayed.
3. **Given** a non-admin user (operator/viewer), **When** they view the catalog
   page, **Then** activate/deactivate buttons are not visible or are disabled.

---

### Edge Cases

- **EC-001**: IF the server API is unreachable THEN display an error state with a retry button.
- **EC-002**: IF an agent has no evaluation THEN show "Not evaluated" in the evaluation column.
- **EC-003**: IF activation fails server-side THEN display an error toast with the server error message.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard SHALL have an Agent Catalog page accessible from the navigation menu.
- **FR-002**: The page SHALL display a table of agents with columns: name, division, status, evaluation score.
- **FR-003**: The page SHALL fetch agent data from `GET /api/catalog/agents`.
- **FR-004**: The page SHALL support filtering by division via query parameter.
- **FR-005**: The page SHALL support text search via `GET /api/catalog/search`.
- **FR-006**: The page SHALL show activate/deactivate buttons for users with `manage:config` permission.
- **FR-007**: Activation SHALL call `POST /api/catalog/activate/:id`.
- **FR-008**: Deactivation SHALL call `POST /api/catalog/deactivate/:id`.
- **FR-009**: The page SHALL display an empty state when no agents are imported.
- **FR-010**: The page SHALL display an error state with retry when the API is unreachable.
- **FR-011**: Non-authenticated users SHALL be redirected to the login page.
- **FR-012**: The page SHALL display summary counts (imported, evaluated, active, rejected) at the top, fetched from `GET /api/catalog/counts`.

### Key Entities

- **Agent**: name, division, status (imported/evaluated/active/inactive/rejected), evaluation score, activation target.
- **CatalogCounts**: imported, evaluated, active, duplicate, rejected counts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operator can view all imported agents within 1 second of page load (for catalogs up to 100 agents).
- **SC-002**: Search results filter within 300ms of query input.
- **SC-003**: Admin can activate or deactivate an agent within 2 clicks from the catalog page.
- **SC-004**: Page correctly reflects the operator's permission level (buttons visible/hidden based on role).

## Non-Goals

- Social login integration (separate feature)
- Agent import flow (separate feature, server-side only)
- Agent evaluation execution (separate feature)
- Agent detail/edit page (separate feature)
- Bulk operations (planned v2)

## Hard Constraints

- **Allowed**: React 18+, Vite, Tailwind CSS (existing dashboard stack)
- **Forbidden**: New dependencies beyond existing stack. No state management library (use existing hooks pattern). No CSS-in-JS (Tailwind only).
- **API contract**: Server routes in `packages/server/src/routes/catalog.ts` are immutable without OpenSpec change.

## Codebase Anchoring

| FR | File | Action |
|----|------|--------|
| FR-001, FR-009, FR-010, FR-011, FR-012 | `packages/dashboard/src/pages/AgentCatalogPage.tsx` | Create |
| FR-002, FR-006, FR-007, FR-008 | `packages/dashboard/src/components/AgentCatalogTable.tsx` | Create |
| FR-003, FR-004, FR-005 | `packages/dashboard/src/lib/api.ts` | Extend (add catalog methods) |
| FR-003, FR-004, FR-005 | `packages/dashboard/src/hooks/useCatalog.ts` | Create |
| FR-001 | `packages/dashboard/src/App.tsx` | Extend (add route) |
| FR-001 | `packages/dashboard/src/components/Layout.tsx` | Extend (add NavLink) |

## Verified Library Specs

| Library | Version | Key API Constraints |
|---------|---------|---------------------|
| React | 18.x (existing) | Hooks only, no class components |
| Vite | 5.x (existing) | No custom plugins needed |
| Tailwind CSS | 3.x (existing) | Utility-first, no custom theme |

## Assumptions

- The server API at `/api/catalog/*` is already implemented and functional.
- The dashboard already has authentication, navigation, and a routing system.
- The dashboard uses React + Vite + Tailwind (existing stack).
- API responses match the existing server route definitions in `catalog.ts`.

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-06-22 | Initial spec created | swarm-execution |
| 2026-06-22 | Status: Draft → Implemented (all 13 tasks completed, all gates passed) | swarm-execution |
| 2026-07-23 | Backfill: Added Non-Goals, Hard Constraints, Codebase Anchoring, Verified Library Specs, Edge Cases (EARS), lifecycle metadata | constitution-upgrade |
