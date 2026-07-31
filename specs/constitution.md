# Djimitflo Specs Constitution

> Project-level constitution for the /specs folder.
> Extends the Djimitflo Constitution v1.2.0 (Article VI — Domain-Driven Design).
> This file defines HOW DDD artifacts are organized in this project.

## Folder Structure

```
specs/
├── constitution.md                    # This file
├── context-map.md                     # BC relationships (single source of truth)
├── bounded-contexts/
│   └── /[bc-name]/
│       ├── domain-terms.md            # Ubiquitous Language glossary
│       ├── bc-[name].md               # Bounded Context Canvas
│       ├── aggregates/
│       │   └── aggregate-[name].md    # Aggregate spec with EARS invariants
│       ├── api/
│       │   └── events.yaml            # Domain event schemas
│       ├── acl-[system].md            # Anti-Corruption Layer (if external)
│       └── requirements.md           # User Stories + Acceptance Criteria
└── tasks/                             # Task decomposition (Spec Kit)
```

## Artifact Ownership

Per Constitution Article VI.6:

| Artifact | Written By | Reviewed By |
|----------|-----------|-------------|
| domain-terms.md | AI (extracted from requirements) | Human (verify Aliases to AVOID) |
| bc-[name].md | AI (drafted from discovery) | Human (verify Business Decisions) |
| context-map.md | AI (drafted from BC analysis) | Human (verify patterns) |
| aggregate-[name].md | **Human** | Human (LLMs only consume) |
| acl-[system].md | **Human** | Human (LLMs only consume) |
| requirements.md | AI + Human | Human (verify EARS format) |
| events.yaml | AI (drafted from aggregate) | Human (verify schemas) |

## Naming Conventions

- Bounded Context folders: `kebab-case` (e.g., `fleet-management`)
- Aggregate files: `aggregate-{name}.md` (e.g., `aggregate-fleet.md`)
- ACL files: `acl-{external-system}.md` (e.g., `acl-stripe.md`)
- Event schemas: `events.yaml` per BC
- All terms in domain-terms.md use PascalCase (matching code conventions)

## Versioning

- Each BC folder is versioned independently
- Breaking changes to domain-terms.md require migration task
- Breaking changes to events.yaml require version bump (v1 → v2)
- Breaking changes to aggregate invariants require TLA+ re-verification

## Compliance

The spec compliance gate (`spec_compliance_gate.py`) enforces:
- Required artifacts per change type (Constitution Article VI.5)
- UL completeness (>= 3 terms, >= 1 Aliases section)
- Invariant coverage (>= 1 INV-### per aggregate, EARS keywords present)
- ACL completeness (Forbidden Concepts section if external integration)

**Version**: 1.0.0 | **Ratified**: 2026-07-24
**Refs**: ../.specify/memory/constitution.md (project constitution v1.2.0)
