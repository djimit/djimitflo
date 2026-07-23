---

description: "Task list template with [P] parallel markers, file paths, verification, and FR traceability (SDD Constitution v1.1.0)"

---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The examples below include test tasks. Tests are OPTIONAL - only include them if explicitly requested in the feature specification.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] [FR] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- **[FR]**: Which functional requirement(s) this task implements (e.g., FR-001, FR-002)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- **Web app**: `backend/src/`, `frontend/src/`
- **Mobile**: `api/src/`, `ios/src/` or `android/src/`
- Paths shown below assume single project - adjust based on plan.md structure

<!--
  ============================================================================
  TASK QUALITY GATES (Constitution v1.1.0)
  
  Every task MUST have:
  1. Exact file path(s) — no ambiguity about what to touch
  2. Action description — what specifically to do (full code if possible)
  3. Verification — a command or test that confirms the task is done
  4. Definition of done — measurable
  5. FR traceability — which FR-### this task implements
  6. [P] marker if parallel-safe (different files, no dependencies)
  7. Dependencies — sequential ordering for dependent tasks
  
  The req_coverage gate verifies: every FR has >= 1 task AND >= 1 test.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic infrastructure

- [ ] T001 [P] [SETUP] Create project structure per implementation plan
  - **Files**: `src/`, `tests/`
  - **Action**: Create directory structure
  - **Verification**: `ls -la src/ tests/`
  - **Done**: Directories exist
  - **FR**: (none — infrastructure)

- [ ] T002 [P] [SETUP] Initialize project with dependencies
  - **Files**: `package.json`
  - **Action**: Initialize with required dependencies
  - **Verification**: `npm install` succeeds
  - **Done**: Dependencies installed
  - **FR**: (none — infrastructure)

- [ ] T003 [P] [SETUP] Configure linting and formatting tools
  - **Files**: `eslint.config.mjs`, `.prettierrc`
  - **Action**: Set up linting configuration
  - **Verification**: `npm run lint` passes
  - **Done**: Linting works
  - **FR**: (none — infrastructure)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST complete before ANY user story can implement

- [ ] T004 [FOUNDATIONAL] [FR-001] Create core data model
  - **Files**: `src/models/[Entity].ts`
  - **Action**: Define TypeScript interfaces for key entities from spec
  - **Verification**: `npm run type-check` passes
  - **Done**: Model compiles
  - **FR**: FR-001

- [ ] T005 [FOUNDATIONAL] [FR-002] Set up API client
  - **Files**: `src/lib/api.ts`
  - **Action**: Create API client with methods for each endpoint
  - **Verification**: `npm run type-check` passes
  - **Done**: Client compiles
  - **FR**: FR-002

---

## Phase 3: User Story 1 — [Brief Title] (Priority: P1) MVP

**Goal**: [What this user story delivers]

**Independent Test**: [How to verify this story independently]

### Tests for User Story 1

- [ ] T006 [P] [US1] [FR-001] Write test for [behavior]
  - **Files**: `src/__tests__/[name].test.ts`
  - **Action**: [full test code with edge cases]
  - **Verification**: `npm test -- [name].test` FAILS (RED phase TDD)
  - **Done**: Test fails as expected
  - **FR**: FR-001

### Implementation for User Story 1

- [ ] T007 [US1] [FR-001] Implement [behavior]
  - **Files**: `src/services/[Name]Service.ts`
  - **Action**: [implementation details]
  - **Verification**: `npm test -- [name].test` PASSES (GREEN phase)
  - **Done**: Test passes
  - **FR**: FR-001

**Checkpoint**: User Story 1 independently functional

---

## Phase 4: User Story 2 — [Brief Title] (Priority: P2)

**Goal**: [What this user story delivers]

**Independent Test**: [How to verify this story independently]

### Tests for User Story 2

- [ ] T008 [P] [US2] [FR-002] Write test for [behavior]
  - **Files**: `src/__tests__/[name].test.ts`
  - **Action**: [full test code]
  - **Verification**: `npm test -- [name].test` FAILS (RED phase)
  - **Done**: Test fails as expected
  - **FR**: FR-002

### Implementation for User Story 2

- [ ] T009 [US2] [FR-002] Implement [behavior]
  - **Files**: `src/services/[Name]Service.ts`
  - **Action**: [implementation details]
  - **Verification**: `npm test -- [name].test` PASSES (GREEN phase)
  - **Done**: Test passes
  - **FR**: FR-002

**Checkpoint**: User Stories 1 AND 2 work independently

---

## Phase 5: User Story 3 — [Brief Title] (Priority: P3)

**Goal**: [What this user story delivers]

**Independent Test**: [How to verify this story independently]

### Tests for User Story 3

- [ ] T010 [P] [US3] [FR-003] Write test for [behavior]
  - **Files**: `src/__tests__/[name].test.ts`
  - **Action**: [full test code]
  - **Verification**: `npm test -- [name].test` FAILS (RED phase)
  - **Done**: Test fails as expected
  - **FR**: FR-003

### Implementation for User Story 3

- [ ] T011 [US3] [FR-003] Implement [behavior]
  - **Files**: `src/services/[Name]Service.ts`
  - **Action**: [implementation details]
  - **Verification**: `npm test -- [name].test` PASSES (GREEN phase)
  - **Done**: Test passes
  - **FR**: FR-003

**Checkpoint**: All user stories independently functional

---

## Phase 6: Polish & Cross-Cutting

**Purpose**: Final validation and cleanup

- [ ] T012 [P] Run full validation suite
  - **Files**: (read-only)
  - **Action**: Run `npm test && npm run type-check && npm run lint`
  - **Verification**: All pass, no new warnings
  - **Done**: Full suite green
  - **FR**: (cross-cutting)

---

## Dependencies & Execution Order

- **Phase 1 (T001-T003)**: No dependencies — all [P] can run in parallel
- **Phase 2 (T004-T005)**: No dependencies — can run in parallel with Phase 1
- **Phase 3 (T006-T007)**: Depends on Phase 2 (needs data model + API client)
- **Phase 4 (T008-T009)**: Depends on Phase 2 (independent of Phase 3)
- **Phase 5 (T010-T011)**: Depends on Phase 2 (independent of Phase 3 and 4)
- **Phase 6 (T012)**: Depends on ALL user stories complete

## Traceability Summary

| FR | Tasks | Tests | Coverage |
|----|-------|-------|----------|
| FR-001 | T004, T006, T007 | T006 | COMPLETE |
| FR-002 | T005, T008, T009 | T008 | COMPLETE |
| FR-003 | T010, T011 | T010 | COMPLETE |

**Rule**: Every FR MUST have >= 1 task AND >= 1 test. req_coverage gate enforces this.
