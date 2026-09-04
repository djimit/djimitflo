# fix: telegram single-poller lease

## What changed

- Added a per-token file lease before Telegram polling starts.
- Duplicate gateway instances now skip polling instead of racing into Telegram
  `409 Conflict` errors.

## Why

The Djimit fleet runs bots across multiple hosts. A single-poller lease prevents
duplicate `getUpdates` consumers from fighting over the same bot token.

## Migration steps

- Optional: set `DJIMIT_TELEGRAM_LEASE_DIR` to a shared durable path for
  multi-host deployments.
- No migration required for single-host deployments.

## Breaking changes

None.

## Known caveats

- The default lease directory is local temp storage; cross-host protection needs
  a shared lease directory.
