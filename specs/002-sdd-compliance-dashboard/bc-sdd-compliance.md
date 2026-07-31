# Bounded Context: SDD Compliance

## Purpose
Evaluate feature specifications against the 7-layer quality gates and provide compliance dashboards and exports.

## Strategic Classification
- **Subdomain Type:** Supporting (enables governance but is not the product)
- **Evolution:** Custom-built (specific to this project's Constitution)
- **Data Classification:** Internal (spec metadata)

## Inbound Communication

| From Context | Channel | Message Type | Pattern |
|--------------|---------|--------------|---------|
| Filesystem | File read | spec.md files | Conformist |

## Outbound Communication

| To Context | Channel | Message Type | Pattern |
|------------|---------|--------------|---------|
| Dashboard UI | HTTP API | ComplianceReport | Published Language |
| Export API | HTTP GET | JSON/CSV download | Open Host Service |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: ComplianceReport, QualityGate, FeatureSpec.

## Business Assumptions
- Specs are stored in specs/ folder as markdown
- Quality gate definitions come from Constitution v1.2.0

## Compliance Verification
- [x] Supporting subdomain → no aggregate spec needed

**Version**: 1.0.0 | **BC**: SDD Compliance
