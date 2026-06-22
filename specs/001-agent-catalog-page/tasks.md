# Tasks: Agent Catalog Dashboard Page

**Input**: Design documents from `/specs/001-agent-catalog-page/`

**Prerequisites**: plan.md (required), spec.md (required), analysis.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: API client extension and data hook — foundation for all user stories

- [ ] T001 [P] Add catalog API methods to `packages/dashboard/src/lib/api.ts`:
  getCatalogCounts(), getCatalogAgents(params?), searchCatalogAgents(q, topK?),
  activateAgent(id, target?), deactivateAgent(id)
  - **Validation**: `npm run type-check` passes; methods match server route signatures
  - **Rollback**: `git checkout -- packages/dashboard/src/lib/api.ts`
  - **Execution Surface**: host:macbook

- [ ] T002 Create `packages/dashboard/src/hooks/useCatalog.ts` data hook:
  fetches counts + agents on mount, manages loading/error/retry state,
  exposes filter/search/activate/deactivate actions
  - **Validation**: `npm run type-check` passes; hook returns expected shape
  - **Rollback**: `git checkout -- packages/dashboard/src/hooks/useCatalog.ts`
  - **Execution Surface**: host:macbook

---

## Phase 2: User Story 1 — View Agent Catalog (Priority: P1) 🎯 MVP

**Goal**: Display all imported agents in a table with summary counts

**Independent Test**: Navigate to /catalog and verify table + counts are displayed

### Tests for User Story 1

- [ ] T003 [P] [US1] Write test for AgentCatalogPage rendering with agents in
  `packages/dashboard/src/pages/AgentCatalogPage.test.tsx`: verify table displays,
  columns present, summary counts displayed
  - **Validation**: `npm test -- --run AgentCatalogPage.test` fails (Red phase)
  - **Rollback**: `git checkout -- packages/dashboard/src/pages/AgentCatalogPage.test.tsx`
  - **Execution Surface**: host:macbook

- [ ] T004 [P] [US1] Write test for empty state in
  `AgentCatalogPage.test.tsx`: verify "No agents imported yet." message
  - **Validation**: `npm test -- --run AgentCatalogPage.test` fails (Red phase)
  - **Rollback**: `git checkout -- packages/dashboard/src/pages/AgentCatalogPage.test.tsx`
  - **Execution Surface**: host:macbook

### Implementation for User Story 1

- [ ] T005 [P] [US1] Create `packages/dashboard/src/components/AgentCatalogTable.tsx`:
  table with columns (name, division, status badge, evaluation score),
  "Not evaluated" for missing evaluation
  - **Validation**: `npm run type-check` passes; component renders table rows
  - **Rollback**: `git checkout -- packages/dashboard/src/components/AgentCatalogTable.tsx`
  - **Execution Surface**: host:macbook

- [ ] T006 [US1] Create `packages/dashboard/src/pages/AgentCatalogPage.tsx`:
  summary counts row (4 stat cards from /api/catalog/counts), table component,
  empty state, error state with retry button. Uses useCatalog hook.
  - **Validation**: `npm test -- --run AgentCatalogPage.test` passes (Green phase)
  - **Rollback**: `git checkout -- packages/dashboard/src/pages/AgentCatalogPage.tsx`
  - **Execution Surface**: host:macbook

- [ ] T007 [US1] Add route to `packages/dashboard/src/App.tsx`:
  `<Route path="catalog" element={<AgentCatalogPage />} />` and add NavLink
  to `packages/dashboard/src/components/Layout.tsx`
  - **Validation**: page is accessible at /catalog; NavLink appears in sidebar
  - **Rollback**: `git checkout -- packages/dashboard/src/App.tsx packages/dashboard/src/components/Layout.tsx`
  - **Execution Surface**: host:macbook

**Checkpoint**: User Story 1 fully functional — catalog page shows agents + counts

---

## Phase 3: User Story 2 — Filter and Search (Priority: P2)

**Goal**: Filter by division and search by name

**Independent Test**: Enter search query, select division filter, verify table filters

### Tests for User Story 2

- [ ] T008 [P] [US2] Write tests for division filter and search in
  `AgentCatalogPage.test.tsx`: verify filtering by division, search by name,
  clearing filters restores full list
  - **Validation**: `npm test -- --run AgentCatalogPage.test` fails for new tests (Red)
  - **Rollback**: `git checkout -- packages/dashboard/src/pages/AgentCatalogPage.test.tsx`
  - **Execution Surface**: host:macbook

### Implementation for User Story 2

- [ ] T009 [US2] Add division filter dropdown and search input (debounced 300ms)
  to `AgentCatalogTable.tsx`: wire to useCatalog hook's filter/search actions
  - **Validation**: `npm test -- --run AgentCatalogPage.test` passes (Green); search debounced
  - **Rollback**: `git checkout -- packages/dashboard/src/components/AgentCatalogTable.tsx`
  - **Execution Surface**: host:macbook

**Checkpoint**: User Stories 1 AND 2 work independently

---

## Phase 4: User Story 3 — Activate/Deactivate (Priority: P3)

**Goal**: Admin can activate/deactivate agents from the catalog page

**Independent Test**: Click activate on a deactivated agent, verify status changes

### Tests for User Story 3

- [ ] T010 [P] [US3] Write tests for activate/deactivate in
  `AgentCatalogPage.test.tsx`: verify buttons visible for admin, hidden for
  non-admin, activate changes status, deactivate changes status, error toast
  on failure
  - **Validation**: `npm test -- --run AgentCatalogPage.test` fails for new tests (Red)
  - **Rollback**: `git checkout -- packages/dashboard/src/pages/AgentCatalogPage.test.tsx`
  - **Execution Surface**: host:macbook

### Implementation for User Story 3

- [ ] T011 [US3] Add activate/deactivate buttons to `AgentCatalogTable.tsx`:
  permission-gated via `useAuthStore.hasPermission('manage:config')`, calls
  useCatalog actions, shows success/error toast
  - **Validation**: `npm test -- --run AgentCatalogPage.test` passes (Green); buttons gated
  - **Rollback**: `git checkout -- packages/dashboard/src/components/AgentCatalogTable.tsx`
  - **Execution Surface**: host:macbook

**Checkpoint**: All user stories independently functional

---

## Phase 5: Polish & Cross-Cutting

**Purpose**: Final validation and cleanup

- [ ] T012 [P] Run full test suite: `npm test` and `npm run type-check` and `npm run lint`
  - **Validation**: all pass, no new warnings
  - **Rollback**: n/a (read-only validation)
  - **Execution Surface**: host:macbook

- [ ] T013 Run quickstart validation: navigate to /catalog, verify all 3 user
  stories work end-to-end in the browser
  - **Validation**: manual verification passes all acceptance scenarios
  - **Rollback**: n/a (read-only validation)
  - **Execution Surface**: host:macbook

---

## Dependencies & Execution Order

- **Phase 1 (T001, T002)**: No dependencies — T001 and T002 can run in parallel
- **Phase 2 (T003-T007)**: T003/T004 (tests) in parallel, then T005 (table), then T006 (page), then T007 (route)
- **Phase 3 (T008-T009)**: Depends on Phase 2 completion
- **Phase 4 (T010-T011)**: Depends on Phase 2 completion (independent of Phase 3)
- **Phase 5 (T012-T013)**: Depends on all user stories being complete
