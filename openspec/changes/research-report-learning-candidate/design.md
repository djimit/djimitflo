# Design

The existing `CitationResearchService` remains the source of stored report facts. The existing `MemoryCandidateService` remains the only candidate lifecycle and promotion authority. The research route composes them; it does not add a crawler, memory store, or approval path.

The route serializes bounded report provenance into a procedural `engineering_rule` candidate. Existing classification makes that candidate `review_required` and blocks promotion until a reviewer acts through the existing approval-protected route. A `research_report:<id>` source reference and an immediate SQLite transaction make repeated requests return the same candidate. Candidate payloads explicitly label external content as untrusted; registered URLs and domain trust scores are not claim verification.

The candidate size is capped at 20,000 characters. Oversized reports are rejected instead of silently truncated. If existing template deduplication finds a similar candidate linked to another report, the route returns a conflict rather than misattributing the old candidate. This endpoint does not fetch URLs, assert live source availability, or mark claims verified.
