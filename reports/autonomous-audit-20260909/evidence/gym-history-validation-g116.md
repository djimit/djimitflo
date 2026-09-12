# G116 gym history validation

`/gym/governance/:skillId/history` now rejects malformed limits (NaN, zero, fractional and over-limit) with structured 400 responses and returns a valid bounded empty history for a clean fixture. Focused test, full server regression (**2439 passed / 20 skipped**), `/loops` (**12/12**), route inventory (**581 routes / 261 contract-tested; 608/608 auth denials**) and full workspace (**2726 passed / 20 skipped**) pass. No deployment or provider-quality claim.
