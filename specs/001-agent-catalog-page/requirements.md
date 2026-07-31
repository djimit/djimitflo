# Requirements — Agent Catalog Bounded Context

> User Stories with Acceptance Criteria in EARS notation.
> Extracted from spec.md (implemented 2026-06-22).

---

## User Story 1 — View Agent Catalog (Priority: P1)

As an operator, I want to see a list of all imported agents with their evaluation status.

**Acceptance Scenarios:**
1. **Given** the server has imported agents, **When** the operator navigates to the Agent Catalog page, **Then** a table displays all agents with name, division, status, and evaluation columns
2. **Given** no agents exist, **When** the operator navigates to the page, **Then** "No agents imported yet" is displayed

---

## User Story 2 — Filter and Search Agents (Priority: P2)

As an operator, I want to filter agents by division and status, and search by name.

**Acceptance Scenarios:**
1. **Given** agents in multiple divisions, **When** a division filter is selected, **Then** only agents in that division are displayed
2. **Given** a search query, **When** it matches an agent name, **Then** only matching agents are shown

---

## User Story 3 — Activate and Deactivate Agents (Priority: P3)

As an admin, I want to activate or deactivate an agent from the catalog page.

**Acceptance Scenarios:**
1. **Given** a deactivated agent, **When** activate is clicked, **Then** status changes to Active
2. **Given** an active agent, **When** deactivate is clicked, **Then** status changes to Inactive

---

## Functional Requirements

- **FR-001:** The system SHALL display all imported agents in a table with name, division, status, and evaluation columns
- **FR-002:** The system SHALL support filtering agents by division
- **FR-003:** The system SHALL support filtering agents by status
- **FR-004:** The system SHALL support searching agents by name
- **FR-005:** The system SHALL allow activating a deactivated agent
- **FR-006:** The system SHALL allow deactivating an active agent
- **FR-007:** THE Agent Catalog SHALL display "No agents imported yet" when empty
- **FR-008:** UNAUTHENTICATED users SHALL be redirected to login

---

## Edge Cases

- **EC-001:** IF the server has no agents THEN display empty state message
- **EC-002:** IF user is not authenticated THEN redirect to login
- **EC-003:** IF search query is empty THEN show all agents
- **EC-004:** IF filter is cleared THEN restore full list

---

## Traceability

| FR | User Story | Test |
|----|-----------|------|
| FR-001 | US1 | test-catalog-renders |
| FR-002 | US2 | test-division-filter |
| FR-003 | US2 | test-status-filter |
| FR-004 | US2 | test-search |
| FR-005 | US3 | test-activate |
| FR-006 | US3 | test-deactivate |
| FR-007 | US1 | test-empty-state |
| FR-008 | US1 | test-auth-redirect |

**Version**: 1.0.0 | **BC**: Agent Catalog
