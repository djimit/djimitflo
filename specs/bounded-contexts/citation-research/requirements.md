# Requirements — Citation Research Bounded Context

> User Stories with Acceptance Criteria in EARS notation.

---

## User Story 1 — Register Source (Priority: P1)

As a researcher, I want to register a source with trust scoring so that claims can be verified.

**Acceptance Scenarios:**
1. **Given** a valid URL, **When** I register a source, **Then** it appears in the source registry with initial trust score
2. **Given** an invalid URL, **When** I try to register, **Then** the system rejects with InvalidSourceError

---

## User Story 2 — Verify Claim (Priority: P1)

As a researcher, I want to verify a claim against its sources so that I can trust the research output.

**Acceptance Scenarios:**
1. **Given** a claim linked only to registered sources, **When** it is recorded, **Then** verified remains false until source content is checked
2. **Given** a claim with no sources, **When** I try to record it, **Then** the system rejects with NoSourceError
3. **Given** a future source-content verifier confirms evidence for a claim, **When** verification completes, **Then** verified = true

---

## User Story 3 — Detect Contradictions (Priority: P2)

As a researcher, I want automatic contradiction detection so that I can resolve conflicts.

**Acceptance Scenarios:**
1. **Given** two conflicting claims, **When** analysis runs, **Then** a Contradiction is created
2. **Given** high-severity contradiction, **When** I try to finalize the report, **Then** the system blocks finalization

---

## User Story 4 — Generate Research Report (Priority: P2)

As a tech lead, I want to generate a complete research report with confidence scoring.

**Acceptance Scenarios:**
1. **Given** verified claims and sources, **When** I generate a report, **Then** it includes all claims, sources, contradictions, and overall confidence

---

## Functional Requirements

- **FR-001:** The system SHALL register sources with trust scores (0-1)
- **FR-002:** The system SHALL link claims to one or more sources
- **FR-003:** The system SHALL NOT mark a claim verified from URL registration or domain trust alone; source-content verification is not currently implemented, so claims remain unverified
- **FR-004:** The system SHALL detect contradictions between claims
- **FR-005:** The system SHALL block report finalization when high-severity contradictions exist
- **FR-006:** The report overall_confidence SHALL average verified claims only and be 0 when none are verified

---

## Edge Cases

- **EC-001:** IF source URL is unreachable or its contents have not been checked THEN registration does not imply that a claim is verified
- **EC-002:** IF no included claims are verified THEN overall_confidence is 0 and the report summary counts them as unverified
- **EC-003:** IF a report contains a high-severity contradiction between included claims THEN generation is rejected and no report is stored

---

**Version**: 1.0.0 | **BC**: Citation Research
