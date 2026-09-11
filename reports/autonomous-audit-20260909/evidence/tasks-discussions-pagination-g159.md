# G159 — task and discussion pagination boundaries

## Finding

`GET /tasks` and `GET /discussions` passed `Number(limit)` and `Number(offset)` directly into SQLite. Zero, negative, fractional and non-numeric windows were not rejected at the HTTP boundary.

## Correction

Both routes now require integer limits from 1–500 and offsets from 0–1,000,000 and return structured `400 VALIDATION_ERROR` responses before querying SQLite.

## Proof

Authenticated task HTTP and discussion HTTP regressions exercise malformed limit/offset values and pass **11/11 tests**. Full server regression passes **2467 tests / 20 skipped**; `/loops` passes **23 files / 291 tests / 1 explicit skip**; build, type-check and lint pass. Route inventory passes **7/7**, reporting **581 source routes / 267 contract-tested**, with zero critical unclassified routes.
