# Domain Terms — Citation Research Bounded Context

> Ubiquitous Language for the Citation Research BC.
> Every term below has exactly one meaning within this BC.

---

## Term: Source

**Definition:**
A verifiable reference (URL, document, database, API) that supports or contradicts a research claim.

**Business Context:**
Sources are registered with a trust score (0-1). They can be verified, updated, or deprecated. A source must have at least one URL or document reference.

**Invariants (EARS):**
- THE Source SHALL have a trust_score between 0 and 1
- WHEN a Source is created THEN it SHALL have a unique id
- IF a Source's trust_score drops below 0.3 THEN mark as untrusted

**Related Terms:**
Claim, ResearchReport

**Aliases to AVOID:**
Reference, Citation, Link, Bookmark, UrlEntry

---

## Term: Claim

**Definition:**
A factual statement that requires verifiable source support to be considered valid.

**Business Context:**
Claims are extracted from research queries. Each claim has a confidence score and must link to at least one source to be considered verified.

**Invariants (EARS):**
- THE Claim SHALL have a confidence score between 0 and 1
- WHEN a Claim is verified THEN it SHALL have at least one source_id
- IF a Claim has no sources THEN its verified status SHALL be false

**Related Terms:**
Source, Contradiction, ResearchReport

**Aliases to AVOID:**
Statement, Assertion, Fact, Proposition, Hypothesis

---

## Term: Contradiction

**Definition:**
A detected inconsistency between two claims that cannot both be true simultaneously.

**Business Context:**
Contradictions are detected during cross-reference analysis. Severity levels: low, medium, high. High-severity contradictions block report finalization.

**Invariants (EARS):**
- THE Contradiction SHALL reference exactly two distinct claims
- WHEN a Contradiction is detected THEN severity SHALL be assigned
- IF severity is 'high' THEN the ResearchReport SHALL NOT be finalized

**Related Terms:**
Claim, ResearchReport

**Aliases to AVOID:**
Conflict, Discrepancy, Inconsistency, Mismatch

---

## Term: ResearchReport

**Definition:**
The final output of a research pipeline, containing verified claims, sources, detected contradictions, and an overall confidence score.

**Business Context:**
Reports are generated on-demand and cached. They include a full audit trail of sources and verification steps.

**Invariants (EARS):**
- THE ResearchReport SHALL include all claims, sources, and contradictions
- WHEN generated THEN overall_confidence SHALL be computed as average of claim confidences
- IF high-severity contradictions exist THEN report SHALL be marked as incomplete

**Related Terms:**
Claim, Source, Contradiction

**Aliases to AVOID:**
Report, Result, Output, Document, Summary

---

## Term: TrustScore

**Definition:**
A numerical value (0-1) indicating the reliability of a source based on verification history and domain authority.

**Business Context:**
Trust scores are computed from: verification frequency, domain reputation, and cross-reference consistency. Scores below 0.3 trigger manual review.

**Invariants (EARS):**
- THE TrustScore SHALL be a real number between 0 and 1
- WHEN a Source is verified THEN its TrustScore SHALL increase
- IF a Source fails verification THEN its TrustScore SHALL decrease

**Related Terms:**
Source

**Aliases to AVOID:**
Score, Rating, Reliability, Authority, Weight

---

**Version**: 1.0.0 | **BC**: Citation Research
