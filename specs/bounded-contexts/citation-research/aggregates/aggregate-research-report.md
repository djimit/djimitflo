# Aggregate: ResearchReport

> Root aggregate of the Citation Research BC.
> Manages the research pipeline from query to verified report.

## Description
The ResearchReport aggregate orchestrates the full citation-gated research pipeline. It manages claims, sources, contradictions, and produces a final verified report with confidence scoring.

## Aggregate Root
`ResearchReport` (entity)

## Member Entities and Value Objects

| Member | Type | Ownership | Notes |
|--------|------|-----------|-------|
| `Claim` | entity | owned | Must have >= 1 source to be verified |
| `Source` | entity | owned | Trust score 0-1 |
| `Contradiction` | entity | owned | References 2 claims |
| `TrustScore` | value object | computed | 0-1 range |
| `Confidence` | value object | computed | Average of claim confidences |

## Enforced Invariants (EARS)

| ID | Invariant | Test |
|----|-----------|------|
| INV-001 | THE Claim SHALL have confidence between 0 and 1 | test-claim-confidence-range |
| INV-002 | WHEN Claim is verified THEN it SHALL have >= 1 source | test-claim-verification-requires-source |
| INV-003 | THE Contradiction SHALL reference exactly 2 distinct claims | test-contradiction-two-claims |
| INV-004 | IF Contradiction severity is high THEN report SHALL NOT be finalize | test-high-contradiction-blocks-finalization |
| INV-005 | THE TrustScore SHALL be between 0 and 1 | test-trust-score-range |

## Commands

| Command | Preconditions | Postconditions | Events Emitted |
|---------|---------------|----------------|----------------|
| `CreateReport(query)` | none | Report created with empty claims | ReportCreated |
| `AddClaim(text, sources)` | Report exists | Claim appended | ClaimAdded |
| `VerifyClaim(claimId)` | Claim has >= 1 source | Claim.verified = true | ClaimVerified |
| `DetectContradictions()` | >= 2 claims exist | Contradictions populated | ContradictionsDetected |
| `Finalize()` | No high-severity contradictions | Report.complete = true | ReportFinalized |

**Version**: 1.0.0 | **BC**: Citation Research | **Root**: ResearchReport
