---
description: "Feature specification template with 7 information layers (SDD Constitution v1.1.0)"
---

# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`

**Created**: [DATE]

**Status**: Draft

**Input**: User description: "$ARGUMENTS"

<!-- 
  ============================================================================
  SPECIFICATION QUALITY GATES (Constitution v1.1.0, Article: Specification Quality Gates)
  
  Every feature spec MUST contain 7 information layers:
  L1 (CRITICAL): Language Precision — FR-### in EARS SHALL-format
  L2 (SHOULD):  Negative Requirements — Non-Goals + Forbidden Libraries
  L3 (CRITICAL): Measurable Criteria — SC-### with number + unit
  L4 (SHOULD):  Hard Constraints — Tech stack versions, forbidden patterns
  L5 (SHOULD):  Codebase Anchoring — FR→file path mapping
  L6 (CRITICAL): Edge Cases — EC-### in IF-THEN format
  L7 (SHOULD):  Verified Library Specs — Library + version + API constraints
  
  CRITICAL layers are hard gates. SHOULD layers allow reviewer override with justification.
  See Constitution v1.1.0 Specification Quality Gates for ratchet policy.
  ============================================================================
-->

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### Edge Cases

<!--
  L6 (CRITICAL): Edge Cases as explicit scenarios.
  Use EARS IF-THEN format. Name each edge case (EC-001, EC-002, etc.).
  Without named edge cases, the agent generates the happy path only.
-->

- **EC-001**: IF [condition] THEN [expected behavior]
- **EC-002**: IF [condition] THEN [expected behavior]
- **EC-003**: IF [condition] THEN [expected behavior]

## Requirements *(mandatory)*

### Functional Requirements

<!--
  L1 (CRITICAL): Language Precision.
  Use EARS SHALL-format. Number each requirement (FR-001, FR-002, etc.).
  "The system SHALL..." is the contract format.
  Ambiguity = agent hallucination. Be explicit.
  
  Example of marking unclear requirements:
  - **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified]
-->

- **FR-001**: The system SHALL [specific capability]
- **FR-002**: The system SHALL [specific capability]
- **FR-003**: The system SHALL [specific capability]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  L3 (CRITICAL): Measurable success criteria.
  Each criterion MUST have a number + unit. "Fast" is not measurable.
  Format: "[quantity] [metric] in [timeframe]" or "[metric] [operator] [threshold]"
-->

### Measurable Outcomes

- **SC-001**: [Measurable metric, e.g., "Users can complete account creation in under 2 minutes"]
- **SC-002**: [Measurable metric, e.g., "System handles 1000 concurrent users without degradation"]
- **SC-003**: [User satisfaction metric, e.g., "90% of users successfully complete primary task on first attempt"]

## Non-Goals

<!--
  L2 (SHOULD): Negative Requirements.
  What does this feature NOT do? Without this section, the agent will add features
  because its default optimism is a bug, not a feature.
-->

- [Feature explicitly out of scope, e.g., "Social login (planned v2)"]
- [Feature explicitly out of scope, e.g., "Password reset flow (separate feature)"]
- [Feature explicitly out of scope, e.g., "Mobile native app (web-only for v1)"]

## Hard Constraints

<!--
  L4 (SHOULD): Hard Technical Constraints.
  What is forbidden — libraries, patterns, APIs. Without this layer, the agent
  selects technology by popularity in its training data — sometimes something
  deprecated for two years.
-->

- **Allowed**: [Tech stack versions, e.g., "React 18+, Vite 5+, Tailwind 3+"]
- **Forbidden**: [Libraries/patterns, e.g., "No jQuery, no class components, no CSS-in-JS"]
- **API contract**: [Existing routes/contracts that must not change without OpenSpec]

## Codebase Anchoring

<!--
  L5 (SHOULD): Architectural context — codebase anchoring.
  A spec anchored in the existing repository: the agent knows specific files and
  dependencies; it doesn't write "in a vacuum."
  Without anchoring, the agent builds a parallel world — that's how it creates
  duplicate classes that it then tries to "unify."
-->

| FR | File | Action |
|----|------|--------|
| FR-001 | `packages/dashboard/src/pages/[PageName].tsx` | Create |
| FR-002 | `packages/dashboard/src/components/[ComponentName].tsx` | Create |
| FR-003 | `packages/dashboard/src/lib/api.ts` | Extend |
| FR-004 | `packages/dashboard/src/hooks/use[Name].ts` | Create |

## Verified Library Specs

<!--
  L7 (SHOULD): Verified library specifications — anti-hallucination.
  A verified library specification describes actual API signatures, not statistical
  guesses. Include the specific library version and key API constraints.
-->

| Library | Version | Key API Constraints |
|---------|---------|---------------------|
| [Library] | [version] | [API constraint, e.g., "Hooks only, no class components"] |
| [Library] | [version] | [API constraint, e.g., "No custom plugins needed"] |

## Assumptions

<!--
  ACTION REQUIRED: Fill in assumptions based on reasonable defaults
  chosen when the feature description did not specify certain things.
-->

- [Assumption about target users]
- [Assumption about scope boundaries]
- [Assumption about data/environment]
- [Dependency on existing system/service]

## Changelog

| Date | Change | Author |
|------|--------|--------|
| [DATE] | Initial spec created | [author]
