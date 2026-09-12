# Outcome-learning canonical route proof — G312

The existing event-ingest fixture now mounts the canonical `/api/swarms/intelligence` path in addition to its legacy compatibility mount and reads the persisted assessment through the canonical authenticated route. Focused outcome-ingest coverage passes 9/9 tests; direct contract coverage is 492/585 with zero critical unclassified routes.

The first `/loops` sweep hit the known Stryker-sandbox authentication race (`auth required` while decoding a response); an immediate complete rerun passed 612/2. The race is retained as evidence and no bypass is claimed.
