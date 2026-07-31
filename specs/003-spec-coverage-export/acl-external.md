# Anti-Corruption Layer: Compliance Export External Clients

> Translates internal ComplianceReport format to external JSON/CSV representations.
> Prevents leak of internal concepts into export format.

---

## Purpose
Serialize compliance data for external consumers (auditors, tech leads) without exposing internal domain model.

## Boundary

- **Inside (our domain):** ComplianceReport, FeatureSpec, QualityGate, LayerCoverage
- **Outside (export format):** JSON object, CSV rows, flat key-value pairs

## Forbidden Concepts (do NOT expose in export)
- Internal spec file paths (relative paths only)
- Internal evaluation timestamps (use ISO date only)
- Internal model class names

## Translation Map (internal → export)

| Internal field | Export field | Transformation |
|----------------|-------------|----------------|
| spec.path | spec_name | basename only |
| spec.lifecycle_state | lifecycle_state | direct |
| report.score | score | percentage (0-100) |
| coverage.L1 | L1 | pass/fail |
| coverage.L2 | L2 | pass/fail |
| coverage.L3 | L3 | pass/fail |
| coverage.L4 | L4 | pass/fail |
| coverage.L5 | L5 | pass/fail |
| coverage.L6 | L6 | pass/fail |
| coverage.L7 | L7 | pass/fail |

## Compliance Verification
- [x] No internal concepts leak to export format
- [x] Export schema is stable and versioned

**Version**: 1.0.0 | **External**: Audit consumers | **BC**: Spec Coverage Export
