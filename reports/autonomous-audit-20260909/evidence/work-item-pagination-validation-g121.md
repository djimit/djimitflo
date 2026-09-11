# G121 work-item pagination validation

`/work-items` now rejects malformed `limit` values before the durable work-item list query. Focused route regression passes; full server regression passes **2443/20**, full workspace passes **2730/20**, `/loops` passes **12/12**, and refreshed route inventory remains **581 routes / 261 contract-tested; 608/608 auth denials**. No external work-item delivery, deployment or production mutation was performed.
