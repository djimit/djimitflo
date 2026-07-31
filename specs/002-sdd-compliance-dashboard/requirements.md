# Requirements — SDD Compliance Bounded Context

> User Stories with Acceptance Criteria in EARS notation.
> Extracted from spec.md (implemented 2026-07-23).

---

## User Story 1 — View SDD Compliance Overview (Priority: P1)

As a developer, I want to see a dashboard showing SDD compliance status of all feature specs.

**Acceptance Scenarios:**
1. **Given** feature specs exist in specs/, **When** the operator navigates to /compliance, **Then** a table displays all specs with L1-L7 coverage and overall score
2. **Given** a spec is missing layers, **When** the compliance page renders, **Then** missing layers are highlighted in red

---

## User Story 2 — Filter and Sort by Compliance (Priority: P2)

As a developer, I want to filter specs by compliance level and sort by score.

**Acceptance Scenarios:**
1. **Given** specs with varying compliance, **When** a compliance filter is selected, **Then** only matching specs are shown
2. **Given** sort by score ascending, **Then** least compliant specs appear first

---

## User Story 3 — Export Compliance Report (Priority: P3)

As a tech lead, I want to export the compliance report as JSON.

**Acceptance Scenarios:**
1. **Given** the compliance page is loaded, **When** "Export JSON" is clicked, **Then** a JSON file downloads with all spec data

---

## Functional Requirements

- **FR-001:** The system SHALL display all feature specs with their L1-L7 compliance status
- **FR-002:** The system SHALL highlight missing layers in red
- **FR-003:** The system SHALL support filtering by compliance level (full, partial, none)
- **FR-004:** The system SHALL support sorting by compliance score
- **FR-005:** The system SHALL provide JSON export of compliance data
- **FR-006:** THE compliance score SHALL be calculated as (layers present / 7) * 100

---

## Edge Cases

- **EC-001:** IF no specs exist THEN display empty dashboard with message
- **EC-002:** IF a spec is missing L1 THEN mark as non-compliant (CRITICAL gate)
- **EC-003:** IF export is requested with no specs THEN return valid empty report

---

## Traceability

| FR | User Story | Test |
|----|-----------|------|
| FR-001 | US1 | test-compliance-overview |
| FR-002 | US1 | test-missing-layers-highlighted |
| FR-003 | US2 | test-compliance-filter |
| FR-004 | US2 | test-sort-by-score |
| FR-005 | US3 | test-json-export |
| FR-006 | US1 | test-score-calculation |

**Version**: 1.0.0 | **BC**: SDD Compliance
