# G263 memory TTL purge truth boundary

The enabled memory worker now identifies itself as `Memory TTL Purge` and reports `Deleted N expired memories by explicit TTL policy`. A focused fixture inserted an expired `vector_memories` row, ran the worker, observed `completed`, and verified the row was removed.

This is intentional TTL deletion, not archival or recoverable cold storage. No claim of archival retention is made.
