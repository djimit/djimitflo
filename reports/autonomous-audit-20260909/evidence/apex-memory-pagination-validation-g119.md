# G119 Apex memory-search pagination validation

`/apex/memory/search` now rejects malformed `limit` values before invoking the embedding provider or memory query. The focused HTTP regression passes; full server regression passes **2441/20**, full workspace passes **2728/20**, `/loops` passes **12/12**, and refreshed route inventory remains **581 routes / 261 contract-tested; 608/608 auth denials**. No external embedding provider, deployment or production mutation was performed.
