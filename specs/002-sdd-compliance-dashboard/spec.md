---
status: draft
created: 2026-07-23
---

# Feature Specification: SDD Compliance Dashboard

**Feature Branch**: `002-sdd-compliance-dashboard`

**Created**: 2026-07-23

**Status**: Draft

**Input**: User description: "Add a dashboard page that shows SDD compliance metrics for all feature specs — 7-layer coverage, lifecycle status, traceability matrix health, and OpenMythos governance gate results."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View SDD Compliance Overview (Priority: P1)

As a developer, I want to see a dashboard page that shows the SDD compliance
status of all feature specs, so I can quickly identify which specs are missing
critical information layers.

**Why this priority**: Without visibility into spec quality, teams cannot enforce
the Constitution v1.1.0 Specification Quality Gates. This is the foundation for
all other compliance work.

**Independent Test**: Navigate to /compliance and verify a table of all specs
with their 7-layer coverage status (L1-L7), lifecycle state, and overall score.

**Acceptance Scenarios**:

1. **Given** the system has feature specs in `specs/`, **When** the operator
   navigates to the SDD Compliance page, **Then** a table displays all specs
   with columns for name, status, L1-L7 coverage, and overall score.
2. **Given** a spec is missing layers (e.g., no Non-Goals), **When** the
   compliance page renders, **Then** the missing layer is highlighted in red.
3. **Given** the operator clicks on a spec row, **Then** a detail view shows
   exactly which layers are present/missing and suggestions for improvement.

---

### User Story 2 - Filter and Sort by Compliance (Priority: P2)

As a developer, I want to filter specs by compliance level (full, partial, none)
and sort by score, so I can prioritize which specs need attention first.

**Why this priority**: Once the overview exists, filtering becomes necessary to
manage more than a handful of specs.

**Independent Test**: Select "Partial compliance" filter and verify only specs
with 3-6 layers present are shown.

**Acceptance Scenarios**:

1. **Given** specs exist with varying compliance levels, **When** the operator
   selects a compliance filter, **Then** only matching specs are displayed.
2. **Given** the operator sorts by score ascending, **Then** the least compliant
   specs appear first.

---

### User Story 3 - Export Compliance Report (Priority: P3)

As a tech lead, I want to export the compliance report as JSON, so I can share
it in reviews or store it as audit evidence.

**Why this priority**: Export enables audit trails and review workflows.

**Independent Test**: Click "Export JSON" and verify the downloaded file contains
all spec compliance data in structured format.

**Acceptance Scenarios**:

1. **Given** the compliance page is loaded, **When** the operator clicks
   "Export JSON", **Then** a JSON file downloads with all spec data.

---

### Edge Cases

- **EC-001**: IF no specs exist in `specs/` THEN display empty state "No specs found. Create your first spec with /speckit.specify."
- **EC-002**: IF a spec file is malformed YAML THEN show error indicator for that spec and continue processing others.
- **EC-003**: IF a spec has all 7 layers present THEN show "Full compliance" badge (green).
- **EC-004**: IF the compliance data is stale (>1 hour old) THEN show refresh indicator and re-scan on next page load.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard SHALL have an SDD Compliance page accessible from the navigation menu at `/compliance`.
- **FR-002**: The page SHALL scan all spec files in `specs/` and `specs/archive/` directories.
- **FR-003**: The page SHALL evaluate each spec for all 7 information layers (L1-L7) from Constitution v1.1.0.
- **FR-004**: The page SHALL display a compliance table with columns: spec name, lifecycle status, L1-L7 presence, overall score.
- **FR-005**: The page SHALL support filtering by compliance level (full/partial/none).
- **FR-006**: The page SHALL support sorting by score, name, and status.
- **FR-007**: The page SHALL provide a detail view showing exactly which layers are present/missing per spec.
- **FR-008**: The page SHALL export compliance data as JSON.
- **FR-009**: The page SHALL cache compliance results for 1 hour before re-scanning.
- **FR-010**: Non-authenticated users SHALL be redirected to the login page.

### Key Entities

- **SpecCompliance**: spec_name, path, lifecycle_status, layers (L1-L7 boolean), overall_score, last_scanned
- **LayerCoverage**: layer_id (L1-L7), layer_name, present (boolean), evidence (string)
- **ComplianceReport**: generated_at, total_specs, full_compliance_count, partial_count, none_count, specs[]

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Compliance page loads in <2 seconds for up to 50 specs.
- **SC-002**: 7-layer evaluation accuracy is 100% (verified against manual inspection of 5 specs).
- **SC-003**: Export JSON contains all required fields and is valid JSON.
- **SC-004**: Page correctly identifies missing layers in 100% of test cases.

## Non-Goals

- Auto-fixing missing layers (manual improvement only)
- Editing specs from the compliance page (read-only view)
- Real-time scanning (1-hour cache is sufficient)
- Integration with OpenMythos governance gates (separate feature)
- Historical trending of compliance scores (v2)

## Hard Constraints

- **Allowed**: React 18+, Vite 5+, Tailwind 3+ (existing dashboard stack)
- **Forbidden**: No new dependencies beyond existing stack. No server-side scanning (client-side only, reads from API). No CSS-in-JS.
- **API contract**: Server endpoint at `GET /api/compliance/specs` must return spec metadata. If endpoint doesn't exist, page shows "API not available" state.

## Codebase Anchoring

| FR | File | Action |
|----|------|--------|
| FR-001, FR-010 | `packages/dashboard/src/pages/CompliancePage.tsx` | Create |
| FR-002, FR-003, FR-004 | `packages/dashboard/src/hooks/useCompliance.ts` | Create |
| FR-004, FR-005, FR-006 | `packages/dashboard/src/components/ComplianceTable.tsx` | Create |
| FR-007 | `packages/dashboard/src/components/ComplianceDetail.tsx` | Create |
| FR-008 | `packages/dashboard/src/lib/compliance-export.ts` | Create |
| FR-001 | `packages/dashboard/src/App.tsx` | Extend (add route) |
| FR-002 | `packages/server/src/routes/compliance.ts` | Create |

## Verified Library Specs

| Library | Version | Key API Constraints |
|---------|---------|---------------------|
| React | 18.x (existing) | Hooks only, no class components |
| Vite | 5.x (existing) | No custom plugins needed |
| Tailwind CSS | 3.x (existing) | Utility-first, no custom theme |

## Assumptions

- The server API at `/api/compliance/specs` will be implemented in a follow-up task.
- The dashboard has authentication, navigation, and routing (existing).
- Spec files are valid markdown with YAML frontmatter.
- The compliance scanning logic runs client-side (reads spec list from API, evaluates layers from returned content).

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-07-23 | Initial spec created using SDD v1.1.0 7-layer template | sdd-e2e-validation |
