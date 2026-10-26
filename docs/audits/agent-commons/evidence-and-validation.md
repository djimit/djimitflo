# Evidence, reproducibility and uncertainty

## Authority and scope

OBSERVED means actual UI/service/source state. VERIFIED means a named claim checked against retained data, exact source or isolated replay. INFERRED identifies proposed causal explanations/designs. UNVERIFIED covers beneficial peer learning, cumulative gain, cost savings and transfer not demonstrated here. Candidate/reflection/presence/transport success do not independently validate outcome quality.

Live deployed source/build: `bf6f647c49b70a65ab795b113f512b9c84ca08a1`, read from production health and checked out separately at `/private/tmp/djimitflo-commons-src`. The authoring workspace remains older/dirty and was preserved. Production advanced after the earlier L6 audit; Commons-specific files were unchanged in that release diff, while other audit fixes had shipped. This investigation still re-queried current state.

## Evidence index

| Artifact | What it establishes / limits |
|---|---|
| [runtime-evidence.json](runtime-evidence.json) / [collector](collect-evidence.mjs) |24 October14:53 UTC, consistent SQLite read-only/query_only transaction; SQL and parameters retained; thread/proposal/reflection/runtime/flag/cost populations; existing pure honest-number readers. No prompts, credentials or full conversation bodies exported |
| [diagnostics.json](diagnostics.json) / [collector](collect-diagnostics.mjs) | Separate consistent read-only snapshot; legacy panel findings/consensus retained as untrusted model text with field-level redaction; lineage, campaign events, lure delivery and evidence coverage. Different capture/window from first file; no silent reconciliation |
| [analysis.json](analysis.json) / [analyzer](analyze-evidence.py) | Recomputed totals, technical review cohort, cost coverage and0/18exact upper interval. Asserts stage counts and retained-source identity |
| [eve-v-poller.json](eve-v-poller.json) | Native service failed/exit 1, execution timestamps. Limited recent journal categories; not underlying provider cause |
| [eve-v-poller-outcomes.json](eve-v-poller-outcomes.json) | Recent bounded journal poll summaries: processed 0 / failures 4 repeatedly; raw messages excluded. Whitelisted classification did not resolve child error |
| [eve-v-script-identity.json](eve-v-script-identity.json) | Native service entry script hash/line count and limit4 differ from pinned repository's limit1/hash. Does not prove causal version regression |
| [01-peer-exchange.png](01-peer-exchange.png) | Selected real peer-topic row among room records and lure history; transcript body is outside this captured viewport. The actual transcript was read through Safari accessibility state, not inferred from the screenshot |
| [02-current-yield.png](02-current-yield.png) | Current page counters, idle resident banner, grounded-stop breakdown and guild table; screenshot visually inspected |
| [source-pinned-tests.log](source-pinned-tests.log) | Seven existing focused files,49 tests passed |
| [review-contract-tests.log](review-contract-tests.log) | Three more existing files,11 tests passed; confirms current parser/grounding fixes already exist |
| [offline-replay.log](offline-replay.log) / [fixture](offline-replay.test.ts) | Four audit-only isolated reproductions passed: feed crowding, weak grounding meaning, missing-source zeros, evidence-ref intersection |
| [focused-tests.log](focused-tests.log) | Initial48pass/1fail: stale locally compiled shared dependency did not export the current settlement-state constant. Not a proven application defect |
| [offline-replay-initial.log](offline-replay-initial.log) | Initial3pass/1fail: audit fixture omitted required agents.description; corrected fixture, not production fault |
| [source-evidence-index.md](source-evidence-index.md) | Immutable implementation/test anchors at the deployed commit |
| [validation.json](validation.json) / SHA256SUMS | Local artifact/link/evidence consistency checks and hashes; not independent scientific replication or full CI |

The service/system-state inspections used existing authorized SSH access, current credentials and read-only queries. No token file/content was read or printed. No POST, lure, message, heartbeat, trial, review, goal, campaign tick, test submission or feature toggle was sent during the live investigation. Normal reads can produce access logs/process counters. Constructors that ensure tables and campaign.tick (which persists state/events) were deliberately not invoked on production readonly data.

## Test execution and source resolution

Existing local dependencies were reused in an isolated checkout; no package download/install or application edit. The initial focused run exposed stale local `@djimitflo/shared` compiled output. A temporary Vitest config aliased it to the pinned checkout's `packages/shared/src/index.ts`. Then49existing tests passed;11review-contract tests and4 audit replay tests also passed. Total:60 existing focused tests plus4 audit-only checks. This is not the entire application suite/CI, and reused dependency versions are not a fresh lockfile installation proof.

Reproduction: create an isolated checkout of the stated SHA, use compatible Node/dependencies, copy offline-replay.test.ts to `packages/server/src/__tests__/commons-audit-replay.test.ts`, and run with the existing server Vitest config plus the pinned shared-source alias. The alias used was:

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from './vitest.config.mts';
export default mergeConfig(base, defineConfig({resolve:{alias:{
  '@djimitflo/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url))
}}}));
```

The replay uses in-memory SQLite and temporary local fixture files. It never executes a model or touches the production database. Its passing tests establish that the documented limitations reproduce; they are not regression tests for fixes that were never implemented. Recompute retained evidence with `python3 docs/audits/agent-commons/analyze-evidence.py`.

## Important uncertainties

- Underlying Hermes child/CLI/provider failure remains unknown. Fresh heartbeat and repeated failures are proven; no native repair was attempted.
- Historical unparseable reviews do not measure the current parser's reliability. Existing code and focused tests already handle/quarantine those failures; a new current review was not generated.
- The0/18grounded child cohort reached no goals, so no downstream execution benefit or harm estimate is possible. It is not0of18failed executions.
- Evidence room “verified” can describe a gym outcome with missing production goal/target/gates/runtime; do not interpret it as a verified production improvement.635such gym summaries were retained.
- Archive status and candidate reflection persistence do not establish idea quality or learned behavior. No mass reopening, deletion or retrospective causal label is justified.
- An attachment classified `artefact` is structured input, not independently passed evidence. Shadow falsifier evaluation runs generated tests; test execution isolation/readiness still needs an authorized real-run proof.
- Text-overlap/peer-uptake metrics, opinions and mechanical source-path checks are proxies. The old campaign's outcome evidence remains UNDETERMINED; no positive learning claim follows from its peer signal.
- External runtime token/price/energy coverage is incomplete. Hermes' total token usage is null in this cohort, not zero; a usage object can be empty. No financial ROI was estimated.
- No full transcript corpus semantic annotation, agent-wide capability benchmark, accessibility/keyboard study or production fault injection was performed. Current source/DB and bounded native evidence support a targeted assessment, not certification of every integration.

## Research sources

Primary papers were checked24 October2026. Use versioned results; the revised agent-scaling paper differs from earlier blog figures. These sources inform the experiment controls and hypotheses, not production conclusions:

- [Kim et al., Towards a Science of Scaling Agent Systems, v3](https://arxiv.org/abs/2512.08296v3): task/architecture alignment and coordination overhead matter. Do not import its reported benchmark gains into Commons forecasts.
- [Du et al., Improving Factuality and Reasoning through Multiagent Debate](https://arxiv.org/abs/2305.14325): debate can help on selected evaluated tasks; it does not imply open-ended ecosystem conversation generates durable software gains.
- [Huang et al., Large Language Models Cannot Self-Correct Reasoning Yet, v2](https://arxiv.org/abs/2310.01798v2): intrinsic self-correction can fail without external feedback. External tests and equal-budget controls remain necessary here.

No memory was updated. Historical session memory was used only to locate existing protocol/lure work; all operational conclusions above were revalidated against this session's live/source evidence.
