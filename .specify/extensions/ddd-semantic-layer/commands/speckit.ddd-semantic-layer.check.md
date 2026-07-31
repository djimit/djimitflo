---
description: "Check DDD artifact completeness for this specification"
---

# DDD Semantic Layer Check

Verify that all required Domain-Driven Design artifacts exist for this feature per Constitution v1.2.0 Article VI.

## Determine Change Type

Based on the feature specification, determine the change type:
- **Greenfield**: New feature or new Bounded Context
- **Brownfield**: Refactoring existing code within known boundaries
- **External**: Integration with an external system (Stripe, CRM, etc.)
- **Bug fix**: Fixing a bug without changing boundaries

## Check Required Artifacts

{% if change_type == "greenfield" %}
Required:
- [ ] `domain-terms.md` — Ubiquitous Language glossary with "Aliases to AVOID"
- [ ] `bc-{name}.md` — Bounded Context Canvas with subdomain classification
- [ ] `requirements.md` — User Stories with EARS acceptance criteria
- [ ] `aggregate-{name}.md` — **HUMAN WRITTEN** if Core subdomain (with EARS invariants)
- [ ] `events.yaml` — Domain event schemas if events produced/consumed
{% elsif change_type == "brownfield" %}
Required:
- [ ] `bc-{name}.md` — Re-discover boundaries if refactoring across modules
- [ ] `aggregate-{name}.md` — **HUMAN WRITTEN** if changing Core subdomain invariants
{% elsif change_type == "external" %}
Required:
- [ ] `acl-{external}.md` — **HUMAN WRITTEN** Anti-Corruption Layer with Forbidden Concepts
- [ ] `events.yaml` — Event schemas for cross-BC communication
- [ ] `context-map.md` — Update BC relationship map
{% elsif change_type == "bugfix" %}
Required:
- [ ] UL discipline only — use correct domain terms in commits and code review
{% endif %}

## Artifact Location

All artifacts go in: `/specs/bounded-contexts/[bc-name]/`

Templates: `~/openspec/specs/ddd-semantic-layer/`

## Gate Result

If any required artifact is missing:
- **BLOCK** plan generation
- List missing artifacts
- Point to template files

If all artifacts present:
- **PASS** — proceed to OpenMythos pre-plan gate
