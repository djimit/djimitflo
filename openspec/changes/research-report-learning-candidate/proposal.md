# Research Reports As Governed Learning Candidates

## Why

DjimitFlo stores source-linked research reports and already has a review-gated memory candidate lifecycle, but the two paths are disconnected. Reusable learning currently requires manually copying report content and can lose source and verification provenance.

## What Changes

- Add a report lookup method and a report-to-memory-candidate endpoint.
- Preserve source URLs, claim identities, verification state and contradictions in the candidate.
- Mark external material as untrusted and require existing review before promotion.
- Make repeated candidate creation for one report idempotent.

## Non-Goals

- Fetching or crawling URLs from the server.
- Automatically verifying claims, creating skills, or promoting memory.
- Replacing the separate research-agent or NotebookLM integrations.
