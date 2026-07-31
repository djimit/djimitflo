# Requirements — Spec Coverage Export Bounded Context

> User Stories with Acceptance Criteria in EARS notation.
> Extracted from spec.md (implemented 2026-07-23).

---

## User Story 1 — Export Compliance Report as JSON (Priority: P1)

As a tech lead, I want to export the SDD compliance report as JSON for audit purposes.

**Acceptance Scenarios:**
1. **Given** specs exist, **When** GET /api/compliance/export?format=json is called, **Then** a JSON file downloads with all spec compliance data
2. **Given** no specs exist, **When** JSON export is requested, **Then** the response contains an empty report with metadata

---

## User Story 2 — Export Compliance Report as CSV (Priority: P2)

As a tech lead, I want to export the compliance report as CSV for spreadsheet analysis.

**Acceptance Scenarios:**
1. **Given** specs exist, **When** CSV export is requested, **Then** a CSV file downloads with headers: spec_name, lifecycle_state, score, L1-L7

---

## Functional Requirements

- **FR-001:** The system SHALL provide GET /api/compliance/export endpoint
- **FR-002:** The endpoint SHALL support ?format=json query parameter
- **FR-003:** The endpoint SHALL support ?format=csv query parameter
- **FR-004:** JSON export SHALL include all fields from the compliance report
- **FR-005:** CSV export SHALL include columns: spec_name, lifecycle_state, score, L1, L2, L3, L4, L5, L6, L7
- **FR-006:** The endpoint SHALL set Content-Disposition header for file download
- **FR-007:** Non-authenticated users SHALL receive 401

---

## Edge Cases

- **EC-001:** IF format parameter is missing THEN default to JSON
- **EC-002:** IF format is unsupported THEN return 400 with supported formats
- **EC-003:** IF no specs exist THEN return valid empty report

---

## Traceability

| FR | User Story | Test |
|----|-----------|------|
| FR-001 | US1 | test-export-endpoint-exists |
| FR-002 | US1 | test-json-export |
| FR-003 | US2 | test-csv-export |
| FR-004 | US1 | test-json-includes-all-fields |
| FR-005 | US2 | test-csv-headers |
| FR-006 | US1 | test-content-disposition |
| FR-007 | US1 | test-auth-required |

**Version**: 1.0.0 | **BC**: Spec Coverage Export
