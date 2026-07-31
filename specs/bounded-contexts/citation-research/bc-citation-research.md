# Bounded Context: Citation Research

## Purpose
Manage citation-gated research pipelines: source registration, claim verification, contradiction detection, and research report generation.

## Strategic Classification
- **Subdomain Type:** Supporting (enhances product quality but is not the core differentiator)
- **Evolution:** Custom-built (no off-the-shelf alternative for citation-gated research)
- **Business Model:** Customer retention (quality assurance)

## Data Classification

| Data Class | Allowed | Required Assurance |
|------------|---------|-------------------|
| public | yes | best_effort |
| internal | yes | validated |
| confidential | no | human-only |

## Inbound Communication

| From Context | Channel | Message Type | Pattern |
|--------------|---------|--------------|---------|
| Orchestration | HTTP API | ResearchRequest | Customer-Supplier |

## Outbound Communication

| To Context | Channel | Message Type | Pattern |
|------------|---------|--------------|---------|
| Dashboard UI | HTTP API | ResearchReport | Published Language |
| Analytics | Event bus | ReportGenerated | Published Language |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: Source, Claim, Contradiction, ResearchReport, TrustScore.

## Business Decisions
- Claims without sources cannot be verified
- High-severity contradictions block report finalization
- Trust scores below 0.3 trigger manual review

## Assumptions
- Source URLs are accessible at registration time
- Claim extraction is handled upstream (not in this BC)

**Version**: 1.0.0 | **BC**: Citation Research
