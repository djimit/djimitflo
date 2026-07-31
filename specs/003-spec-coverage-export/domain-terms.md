# Domain Terms — Spec Coverage Export Bounded Context

> Ubiquitous Language for the Spec Coverage Export BC.
> Every term below has exactly one meaning within this BC.

---

## Term: CoverageExport

**Definition:**
A machine-readable export of SDD compliance data in JSON or CSV format for audit purposes.

**Business Context:**
Generated on-demand via API endpoint. Used by tech leads and auditors to archive compliance state.

**Invariants (EARS):**
- THE CoverageExport SHALL include all spec compliance data
- WHEN format=json THEN the export SHALL be valid JSON
- WHEN format=csv THEN the export SHALL have headers: spec_name, lifecycle_state, score, L1-L7

**Related Terms:**
ExportFormat

**Aliases to AVOID:**
Export, Download, Report, File

---

## Term: ExportFormat

**Definition:**
The serialization format for a compliance export — either JSON or CSV.

**Business Context:**
JSON for machine consumption, CSV for spreadsheet analysis. Default is JSON.

**Invariants (EARS):**
- THE ExportFormat SHALL be one of: json, csv
- WHEN format is unsupported THEN return 400 with supported formats
- WHEN format is missing THEN default to json

**Related Terms:**
CoverageExport

**Aliases to AVOID:**
Format, Type, Serialization

---


## Term: AuditTrail

**Definition:**
A chronological record of compliance exports, used for audit purposes and regulatory compliance.

**Business Context:**
Every export generates an audit trail entry with timestamp, format, and spec count. Audit trails are immutable once written.

**Invariants (EARS):**
- THE AuditTrail SHALL include: timestamp, format, specCount, userId
- WHEN an export completes THEN an AuditTrail entry SHALL be created

**Related Terms:**
CoverageExport, ExportFormat

**Aliases to AVOID:**
Log, History, TraceRecord, AuditLog

**Version**: 1.0.0 | **BC**: Spec Coverage Export
