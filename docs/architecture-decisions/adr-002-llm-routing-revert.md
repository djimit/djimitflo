# ADR-002: Reverted LLM routing change

Status: reverted; reconsider only as a fresh, independently tested change.

Commit `22058a3` claimed an LLM-routing feature. Commit `5c9e911` restored the mainline router and Docker-sandbox tests because the cherry-pick was incompatible with the current implementation. The reverted behavior is not a production capability.

Any renewed routing change must demonstrate its behavior in `llm-router-service.ts` and include a route-level regression test; a feature commit message alone is not evidence.
