# OpenMythos validated-cache and provenance integrity

Scope: `OpenMythosEvalService` and a new focused cache regression file. No operator corpus, manifest, oracle file, external service, certification rule or deployment was changed.

## Reproduced failures

The service populated `casesCache` before checking the corpus manifest and populated `anchorsCache` before validating the entire oracle document. The first call rejected invalid evidence; the second call reused that partial cache without revalidation. Invalid oracle configuration could therefore become an empty-cache judge fallback. In addition, persisted run provenance and discrimination lookup rehashed current disk content even though execution still used previously cached prompts/oracles. The public case array also allowed a caller to mutate subsequent cached prompts or append unvalidated cases.

`openmythos-cache-red.log` records **11 failing tests** against the prior implementation: four manifest failures, five oracle failures, disk/cache hash mismatch and mutable case-cache behavior.

## Correction and proof

All corpus/manifest checks and all oracle-entry checks complete in local variables before their caches are published. Hashes derive from the exact bytes parsed for each validated snapshot, not a second file read. Those snapshot hashes are retained for run metadata and prior discrimination-evidence lookup. Case consumers receive a new array containing frozen case records. Failed loads remain retryable after a fixture is repaired; successful caches retain their validated snapshot until a new service instance is created.

- `openmythos-cache-green.log`: **51 passed / 4 files** (17:25 checkpoint), including 12 focused cache tests plus existing evaluation, nightly and scorecard regressions.
- `openmythos-cache-type-check.log`, `openmythos-cache-lint.log`: exit 0. Focused `git diff --check`: exit 0.
- Repeated malformed/missing/hash-mismatched manifest or anchor loads continue to reject; a corrected fixture subsequently loads on the same service.
- A changed corpus/anchor file does not relabel cached content. Persisted run metadata retains the original SHA-256 values; a new service reads the new valid corpus. The discrimination lookup likewise uses the cached corpus hash.
- The provenance test explicitly forbids fetch and substitutes empty worker results, yielding a **failed** fixture run rather than pretending an agent or judge completed evaluation. Existing evaluation regressions use their pre-existing mocked provider responses; no real provider was invoked.

Temporary fixtures were removed after tests; only generated disposable files were deleted. No live OpenMythos evidence was altered.

## Certification remains blocked

The inspected `openmythos-browser-session.json` is a historical assurance snapshot: 351 cases, only 7 validated, 318 reviewed and 26 draft; certification-ready manifest false; repeatability and held-out discrimination not executed. This patch cannot supply those missing authority/evaluation prerequisites and does not change their admission gates. It corrects local evidence handling, not broad governance certification or provider readiness. Cache refresh is deliberately not automatic; restart/recreate the service to adopt a new validated snapshot.
