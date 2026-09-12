# G117 authority pagination validation

`/authority/events` now rejects negative, fractional and non-numeric `limit`/`offset` values with structured HTTP 400 responses instead of silently coercing them to defaults. The authenticated approval/authority HTTP regression passes 2/2; full server regression passes **2439/20**, full workspace passes **2726/20**, `/loops` passes **12/12**, and route inventory remains **581 routes / 261 contract-tested; 608/608 auth denials**. No deployment or external-ledger provisioning was performed.
