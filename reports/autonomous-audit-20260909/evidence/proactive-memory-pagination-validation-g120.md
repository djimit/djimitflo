# G120 proactive-memory pagination validation

`/memory/top` and `/memory/search` now reject malformed `limit` values before reading or embedding memory. Focused route regression passes; full server regression passes **2442/20**, full workspace passes **2729/20**, `/loops` passes **12/12**, and refreshed route inventory remains **581 routes / 261 contract-tested; 608/608 auth denials**. No external embedding provider, deployment or production mutation was performed.
