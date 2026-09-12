# Assurance prerequisites — bounded independent continuation

Date: 2026-09-09. Initial investigation read-only; no external checkout/configuration edits, indexing, provider calls, certification or promotion. Python probes used `-B`/`PYTHONDONTWRITEBYTECODE=1`; reviewed scripts only read files and print results. Local facts below were freshly checked, not inferred from historical reports.

## Knowledge validator: data/tool location coupling, not a renamed command

- Audit `knowledge` symlink resolves to `/Users/dlandman/djimitflo-knowledge/okf`. Its parent is a data-only directory containing `okf`, not a repository checkout with `tools`. Thus the expected sibling `tools/validate_okf.py` genuinely does not exist there.
- `KnowledgeRuntimeService.validateOkf` currently derives the validator from the data directory's parent (`knowledge-runtime-service.ts:329`). This unnecessarily couples data placement to tooling placement.
- Existing canonical-source checkout `/Users/dlandman/VPS/djimitflo-knowledge-eve-l3` is clean at `ab885d8b4350e43ef1759bf52c72750e3273fbc5`, remote `https://github.com/djimit/djimitflo-knowledge.git`. `tools/validate_okf.py` still exists and `pyproject.toml` exposes `okf-validate = tools.validate_okf:main`. History confirms this remains the maintained command, not a stale removed path.
- That validator SHA-256 is `4d3b6c869e000096d23201143f27b623399eb96b45977adf6882c79f55ac1357`; it matches the existing `djimitflo-knowledge-ci-fix` checkout. Older `djimitflo-knowledge-live` has a different, simpler validator and a dirty worktree; do not silently substitute that older implementation.
- The maintained validator supports `OKF_BASE` through `tools/okf_config.py`; its imports and executed main perform no network requests or file writes. A real read-only execution from the clean checkout returned exit0, `OK: 41 OKF documents valid` against its own bundle, and exit0, `OK: 174 OKF documents valid` with `OKF_BASE=/Users/dlandman/djimitflo-knowledge/okf`.

Reproducible command, without changing shell/global configuration:

```sh
cd /Users/dlandman/VPS/djimitflo-knowledge-eve-l3
OKF_BASE=/Users/dlandman/djimitflo-knowledge/okf PYTHONDONTWRITEBYTECODE=1 python3 -B tools/validate_okf.py
```

**Coverage limitation:** the 174-file message is not evidence that 174 typed knowledge objects passed schema checks. Aggregate inspection found 86 `CompletedTask`, 86 `Reasoning`, one `Agent`, and one absent type (index). The validator deliberately excludes the 172 explicit non-OKB types from typed/index checks. The current skills directory is empty. Preserve this distinction in health/capability claims.

### Minimal product correction authorized after investigation

Support a trusted operator-configured absolute `OKF_VALIDATOR_PATH`, preserving the actual data bundle and passing its resolved path explicitly as `OKF_BASE`. Keep the existing colocated validator as default; never copy, synthesize or weaken the external validator. Missing/unavailable validator must fail validation, and applying capability sync must require an actual `pass`, not merely absence of `fail`.

Source-proven pre-fix bypass: missing validator returns `skipped`, while `syncCapabilities` only rejects `fail`. `health.valid` is false but mutation can proceed. `nextSafeActions` also misleadingly skips prerequisite repair for `skipped`. No real capability-sync mutation was performed during investigation.

Deep health independently requires validator `pass` (`routes/health.ts:63`) and will still report configured unavailable dependencies. The isolated audit server deliberately points Ollama/Qdrant to refused loopback endpoints; restoring knowledge validation alone does not establish all-dependency health. `assurance:live` additionally requires a clean intended revision, matching full commit/database instance, live data mode, and healthy authenticated provenance; the intentionally dirty audit worktree remains an independent blocker.

## OpenMythos: current structural commands work; broad eligibility remains blocked

- Actual nested repository is `/Users/dlandman/OpenMythos/openmythos-benchmark`, remote `https://github.com/djimit/openmythos-benchmark.git`, HEAD `4edbb42416658cca6c059402867f0dd1a5be3f5c`, with existing modifications including schema/validator and untracked manifest. Parent `/Users/dlandman/OpenMythos` is a different uncommitted outer repository; do not confuse its Git status with benchmark provenance.
- Read-only `python3 -B scripts/validate.py` executed exit0: all351 cases structurally valid across11 categories. `python3 -B scripts/skill_lifecycle_gate.py` executed exit0:18 **draft** cases,6 stages, exact deterministic-anchor coverage, explicitly no promotion.
- Actual corpus SHA-256: `71ca62e742f71c2830f198c01dbcacdcf75487b9ef96e661d3e297d6608d41b9`; manifest count/hash match. Maturity remains318reviewed,26draft,7validated; manifest `certification_ready:false`.
- Existing historical `apex-r28-deterministic-repeatability.json` records8cases/24calls/3repetitions for `qwen2.5:14b-instruct-q4_K_M`, stable outcomes but only4oracle passes per repetition. This is not current351-case/subject-model certification evidence. No model was run to refresh it.
- Existing `apex-r21-djimitflo-calibration.json` declares `calibrated:true` but `certification_eligible:false`; it cannot supply a green promotion assertion. Runtime `GovernanceGuardService.isCalibrationEligible` additionally binds report run_id/agent_id and requires all case rows plus eligible=true.
- `scripts/openmythos-evidence.mjs` actually invokes the two supported validators above; there is no missing-validator path mismatch here. It always labels repeatability and held-out discrimination `not_run`, and does not consume the historical reports. Do not substitute those reports or relabel draft cases to manufacture success.

**Independent latent false-green finding (subsequently corrected locally):** before correction, `broadCertificationReady` checked only both structural command exits and `maturity.validated === cases.length`, while emitted repeatability/held-out gates remained `not_run` and manifest `certification_ready` was ignored. Original real inputs correctly blocked, but merely relabelling all cases validated made the script return pass without the additional claimed evidence. No external OpenMythos source changed.

## Authorized local correction and executed verification

After the read-only findings, parent authorized the minimal adapter fix. `knowledge-runtime-service.ts` now accepts only an absolute operator-environment `OKF_VALIDATOR_PATH`; the default colocated validator remains supported. It forwards the real data path as `OKF_BASE`, invokes `python3 -B` with bytecode disabled, bounds the process to10seconds/SIGKILL, does not fall back if explicit tooling is invalid, and requires validation `pass` before sync apply. Read-only preview remains available. README and server env-example explain the trust/coverage boundary. No external repository, global environment, or running server configuration was changed by this agent.

- RED:6new regression cases failed against the old implementation,5existing runtime tests passed (`knowledge-validator-red.log`). Cases cover separate tools/data, missing validator, explicit missing/relative/failing validator, and a skipped-result sync guard.
- GREEN:17tests across runtime health, capability sync, and knowledge bus passed (`knowledge-validator-green.log`). One prior positive sync fixture had relied on missing validation; it now includes a clearly labelled disposable passing fixture validator, preserving all existing sync assertions.
- Actual patched `KnowledgeRuntimeService.health()` with ephemeral SQLite plus the unchanged external validator and actual databundle returned `validate_okf.status:pass`, `valid:true`, empty blocked reasons (`knowledge-validator-real-service.log`). Runtime counts were0skills,1agent,86memory entries; the validator's separate174-document message includes task files and the172explicit non-OKB exclusions documented above. No live capability-sync apply occurred.
- Scoped ESLint and `git diff --check` passed. Initial server-wide typecheck was blocked by concurrent edits outside this slice (`index.ts` unused import, intervention auth payload, Telegram return typing), preserved in `knowledge-validator-typecheck.log`; parent owns integration/recheck.
- Operator audit-server override, if parent elects to use it: `OKF_VALIDATOR_PATH=/Users/dlandman/VPS/djimitflo-knowledge-eve-l3/tools/validate_okf.py`; retain the actual `OKF_BASE`/knowledge symlink. This is local structural-tool provenance, not an approved production deployment source.

## Follow-up: false-green predicate correction

Parent separately authorized the bounded fix to `scripts/openmythos-evidence.mjs` and new executable Node test `scripts/openmythos-evidence.test.mjs`.

- RED: the actual report CLI returned unsafe `pass`/exit0 with all-labelled-validated fixture cases and manifest `certification_ready` values false/true/string/null, and certified an empty corpus vacuously. Five cases failed assertions; three existing negative/failure-contract cases passed (`openmythos-admissibility-red.log`). Fixtures used isolated temporary data and clearly labelled structural stand-ins, never a real corpus mutation or model call.
- GREEN:8/8 tests passed (`node scripts/openmythos-evidence.test.mjs`, `openmythos-admissibility-green.log`). The predicate now requires a nonempty fully validated corpus, existing manifest boolean readiness, and actual pass states for existing repeatability/held-out gates. Because this command executes only structural validators, those two gates remain honestly `not_run` and broad certification remains unavailable. No newly invented evidence format, static attestation, override flag or external report substitution was introduced.
- Existing fail-vs-blocked exit behavior and manifest hash mismatch handling remain tested. Both scripts pass Node syntax checks and scoped diff checks.
- Actual external validators were rerun with Python bytecode disabled, writing only a new audit evidence report: `openmythos-admissibility-current.json`. Structural351-case validation and18-draft lifecycle validation pass; current maturity7validated/318reviewed/26draft and manifest readinessfalse remain unchanged. Overall result is `blocked`, exit2, structural acceptance true, broad certification false.

## Status

Knowledge data/tool separation and the local broad-certification false-green predicate are repaired and execution-tested; external validation and model governance remain authoritative. No data-source/projection switch, provider execution, certification, promotion or merge performed. OpenMythos broad assurance and clean/live deployment identity remain independently blocked.
