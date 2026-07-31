# Bounded Context: Spec Coverage Export

## Purpose
Provide API endpoints for exporting SDD compliance reports in JSON and CSV formats.

## Strategic Classification
- **Subdomain Type:** Generic (could be replaced by off-the-shelf reporting)
- **Evolution:** Custom-built (specific to this project's compliance schema)
- **Data Classification:** Internal (compliance metadata)

## Inbound Communication

| From Context | Channel | Message Type | Pattern |
|--------------|---------|--------------|---------|
| Client | HTTP GET | /api/compliance/export | Customer-Supplier |

## Outbound Communication

| To Context | Channel | Message Type | Pattern |
|------------|---------|--------------|---------|
| Client | HTTP Response | JSON/CSV file | Open Host Service |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: CoverageExport, ExportFormat.

## Business Assumptions
- Compliance data is pre-computed by the SDD Compliance BC
- Export is read-only (no side effects)

## Compliance Verification
- [x] Generic subdomain → minimal DDD artifacts (UL discipline only)

**Version**: 1.0.0 | **BC**: Spec Coverage Export
