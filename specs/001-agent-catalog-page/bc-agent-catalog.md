# Bounded Context: Agent Catalog

## Purpose
Manage the display, filtering, searching, and activation of imported agents in the dashboard.

## Strategic Classification
- **Subdomain Type:** Supporting (necessary for operations but not the core product differentiator)
- **Evolution:** Custom-built (tightly coupled to dashboard UI)
- **Data Classification:** Internal (agent metadata, not PII)

## Inbound Communication

| From Context | Channel | Message Type | Pattern |
|--------------|---------|--------------|---------|
| Server API | HTTP | GET /api/catalog/* | Customer-Supplier |

## Outbound Communication

| To Context | Channel | Message Type | Pattern |
|------------|---------|--------------|---------|
| Dashboard UI | Internal | AgentList, FilterState | Published Language |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: Agent, Catalog, Division, Evaluation.

## Business Decisions
- Deactivated agents cannot be assigned new tasks
- Empty catalog shows explicit empty state message
- Division filtering is exact match (no partial)

## Assumptions
- Server API already exists at /api/catalog/*
- Agent data is already imported (this BC only displays/manages)

## Compliance Verification
- [x] Artifact ownership: Supporting subdomain → AI-drafted, human-verified
- [x] No aggregate spec needed (Supporting BC, anemic model OK)

**Version**: 1.0.0 | **BC**: Agent Catalog
