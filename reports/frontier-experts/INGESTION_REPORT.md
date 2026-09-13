# Ingestion report — Pacing the Frontier seed (§8, §33)

Service: `packages/server/src/services/pacing-frontier-ingestion-service.ts` · tests: `packages/server/src/__tests__/pacing-frontier-ingestion.test.ts` (3 passing).

## How the public site behaves (inspected 2026-09-13)

- `https://www.pacingthefrontier.com/robots.txt` → 404 (Next.js not-found page); no crawl restrictions declared. No CAPTCHA, no authentication.
- The homepage (256 KB, server-rendered Next.js) contains the **complete** signatory list and the public comments inside the React flight payload (`self.__next_f.push([1, "..."])`), as props `signatories` (1 386 objects `{name,title,quoteId}`), `quotes` (100 objects `{id,name,title,quote}`) and `signatoryCount: 1386`. The client renders 20 and reveals the rest behind "Show more" from memory. There is no `/api/...` endpoint; candidate JSON URLs return 404. The client JS chunk additionally embeds a 39-entry **placeholder** dataset (fictional names such as "Adrian Voss") that must not be mistaken for signatories; the parser only reads the flight payload.
- Consequence: one GET per ingestion run is sufficient and correct. The service enforces at most one live fetch per hour (`rate_limited`), hashes the content (`expert_source_snapshots`), and identifies evidence deterministically so re-runs are no-ops.

## Parser

`parsePacingFrontier(html)` decodes the JS-literal layer and the JSON layer one escape at a time (no `eval`, no DOM), then extracts signatories and quotes with anchored regular expressions. Output on the saved page:

| metric | value |
|---|---|
| `signatoryCount` declared by the site | 1 386 |
| raw signatory objects in payload | 1 386 |
| distinct (name, title) pairs | 1 103 |
| of which `Anonymous` (name withheld; 283 raw rows over 9 org pairs) | 9 pairs, skipped: no identity to resolve |
| named identities discovered | 1 094 |
| signatories with a public comment | 99 (95 attached after de-duplication) |
| quotes parsed | 100 |
| top self-stated organizations | Anthropic 452, OpenAI 334, Google 180, Meta 75, Thinking Machines 11, Google DeepMind 7 |

## What ingestion writes (and does not)

- `expert_identities`: 1 094 rows in `DISCOVERED`, provenance `{source, seed_title, statement, retrieved_at, snapshot_id, signature_ref}`.
- `expert_evidence`: 1 094 rows, kind `signature`, tier 4, `source_family = pacingthefrontier.com`, metadata limited to self-stated title, statement, quote id, public comment, snapshot id (§27 data minimisation).
- `expert_affiliations`: 1 094 self-declared rows, confidence 0.5, `valid_from/valid_to` null (the signature gives no dates), `source_ref` = the signature evidence id.
- `expert_capabilities`: **0** (I01). `expert_source_snapshots`: one row per run with the content hash.
- Second run on identical content: `discovered_new 0, already_known 1094, affiliations_added 0`; evidence ids identical (INSERT OR IGNORE). Runtime 259 ms for both runs.

## Limitations and next steps

- Same-name signatories with different titles become separate DISCOVERED rows; identity resolution (E2) decides whether they are one person or two, and fails closed as AMBIGUOUS otherwise (I03).
- The self-stated title is a Tier-4 signal; affiliations remain at confidence 0.5 until an institutional page or profile (Tier 1) confirms them.
- Live fetch is implemented but this report used the saved page from the same day to avoid a second request.

Capability status: **PROVEN** (parser on the real page, idempotent ingestion in a real SQLite database with the production schema and migrations; no lifecycle advance beyond DISCOVERED).
