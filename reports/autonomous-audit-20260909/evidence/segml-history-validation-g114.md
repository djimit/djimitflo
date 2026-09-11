# G114 SEGML history validation

`/segml/history` now rejects malformed `limit` values (NaN, zero, fractional and over-limit) with structured 400 errors and returns an empty valid bounded page for a clean fixture. Focused route test, full server regression (**2437 passed / 20 skipped**), `/loops` checks (**12/12**) and full workspace regression (**2724 passed / 20 skipped**) pass. Route inventory/auth probing passes with **581 source routes / 260 contract-tested references** and **608/608 anonymous auth denials**. No deployment or provider-quality claim.
