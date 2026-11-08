## ADDED Requirements

### Requirement: Research Reports Become Reviewable Learning Candidates

DjimitFlo SHALL allow a stored citation-linked research report to be submitted to the existing memory-candidate lifecycle without treating external claims as verified or active knowledge.

#### Scenario: Report is submitted as a candidate

- **WHEN** an authorized operator submits an existing report for memory candidacy
- **THEN** DjimitFlo creates one procedural memory candidate containing report, claim, source, contradiction and verification provenance
- **AND** marks external content as untrusted data
- **AND** leaves the candidate review-required and unpromoted

#### Scenario: Candidate submission is repeated

- **WHEN** the same report is submitted again
- **THEN** DjimitFlo returns the existing candidate without creating another record

#### Scenario: Similar candidate belongs to another report

- **WHEN** template deduplication identifies a candidate linked to another research report
- **THEN** DjimitFlo returns a conflict and preserves the original candidate's provenance

#### Scenario: Report is missing or exceeds the candidate limit

- **WHEN** the report does not exist or its serialized evidence exceeds the bounded candidate size
- **THEN** DjimitFlo returns an explicit error
- **AND** creates no memory candidate
