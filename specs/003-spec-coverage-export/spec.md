---
status: draft
created: 2026-07-23
---

# Feature Specification: Spec Coverage Export

**Feature Branch**: `003-spec-coverage-export`

**Created**: 2026-07-23

**Status**: Draft

**Input**: User description: "Add the ability to export SDD compliance reports as JSON or CSV for audit purposes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Export Compliance Report as JSON (Priority: P1)

As a tech lead, I want to export the SDD compliance report as JSON, so I can
archive it or share it with auditors.

**Why this priority**: Audit trails require exportable artifacts. JSON is the
most common format for machine-readable compliance reports.

**Independent Test**: Call GET /api/compliance/export?format=json and verify the
response contains all spec compliance data in valid JSON format.

**Acceptance Scenarios**:

1. **Given** specs exist in `specs/`, **When** the user requests JSON export,
   **Then** a JSON file downloads with all spec compliance data.
2. **Given** no specs exist, **When** the user requests JSON export,
   **Then** the response contains an empty report with metadata.

---

### User Story 2 - Export Compliance Report as CSV (Priority: P2)

As a tech lead, I want to export the compliance report as CSV, so I can open it
in Excel for further analysis.

**Why this priority**: CSV enables spreadsheet-based analysis by non-technical
stakeholders.

**Independent Test**: Call GET /api/compliance/export?format=csv and verify the
response is valid CSV with headers.

**Acceptance Scenarios**:

1. **Given** specs exist, **When** the user requests CSV export,
   **Then** a CSV file downloads with headers: spec_name, lifecycle_state, score, L1-L7.
2. **Given** a spec has full compliance, **When** CSV is generated,
   **Then** all layer columns show "pass".

---

### Edge Cases

- **EC-001**: IF the format parameter is missing THEN default to JSON.
- **EC-002**: IF the format is unsupported THEN return 400 with supported formats.
- **EC-003**: IF no specs exist THEN return a valid empty report.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server SHALL provide GET /api/compliance/export endpoint.
- **FR-002**: The endpoint SHALL support `?format=json` query parameter.
- **FR-003**: The endpoint SHALL support `?format=csv` query parameter.
- **FR-004**: JSON export SHALL include all fields from the compliance report.
- **FR-005**: CSV export SHALL include columns: spec_name, lifecycle_state, score, L1, L2, L3, L4, L5, L6, L7.
- **FR-006**: The endpoint SHALL set Content-Disposition header for file download.
- **FR-007**: Non-authenticated users SHALL receive 401.

### Key Entities

- **ComplianceExport**: format (json|csv), generated_at, report (ComplianceReport)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: JSON export completes in <100ms for up to 50 specs.
- **SC-002**: CSV export produces valid RFC 4180 CSV.
- **SC-003**: Both formats contain identical data.

## Non-Goals

- PDF export (future)
- Scheduled automatic exports (future)
- Export of historical compliance trends (future)

## Hard Constraints

- **Allowed**: Node.js built-in modules only (fs, path). No new dependencies.
- **Forbidden**: No external CSV libraries (hand-roll CSV generation).
- **API contract**: Reuses existing SpecComplianceService.

## Codebase Anchoring

| FR | File | Action |
|----|------|--------|
| FR-001, FR-002, FR-003 | `packages/server/src/routes/compliance.ts` | Extend |
| FR-004, FR-005 | `packages/server/src/services/spec-compliance-service.ts` | Extend |
| FR-006 | `packages/server/src/routes/compliance.ts` | Extend |

## Verified Library Specs

| Library | Version | Key API Constraints |
|---------|---------|---------------------|
| Node.js fs | Built-in | Read-only access to specs/ directory |
| Node.js path | Built-in | Cross-platform path handling |

## Assumptions

- The existing SpecComplianceService provides scan data.
- The existing compliance route is already registered.
- Authentication is handled by existing middleware.

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-07-23 | Initial spec created | sdd-workflow |
