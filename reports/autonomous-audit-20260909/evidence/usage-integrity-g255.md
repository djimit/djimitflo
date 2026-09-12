# G255 usage telemetry integrity

`POST /api/usage/tokens` now rejects malformed batches before SQLite: IDs must be non-empty strings, token and latency fields must be bounded nonnegative integers, timestamps must parse, task types must be supported, and batches are capped at 1,000 entries. A valid batch is persisted and returned with its actual insert count.

Focused usage HTTP regression passes 2/2. Full server regression passes 2,514 tests / 20 skipped; full workspace passes 2,805 / 20 skipped; `/loops` passes 291 / 1 skipped. Usage quality and external provider delivery remain unverified.
