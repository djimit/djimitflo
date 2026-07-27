# Design

## Canonical loop

OpenMythosEvalService detects failures. GovernanceFeedbackLoopService creates
and authorizes a bounded proposal. ExecutionEngine performs the actual task.
The same evaluator then measures the candidate. Existing proposal and feedback
tables hold lineage.

## Repeated verification

For the failing case set:

1. retain the discovery run;
2. collect enough pre-change runs to reach the configured repeat count;
3. execute the improvement;
4. collect the same number of post-change runs;
5. pair run-level means by repeat;
6. compute mean delta, sample standard error and a 95 percent lower bound;
7. require the lower bound to exceed the configured minimum effect.

Previously passing cases from the discovery run form a small regression
holdout. Their mean delta may not fall below the configured tolerance.

One repeat remains supported for isolated tests and explicit low-cost use, but
production defaults to three.

## Manifest

The proposal stores:

- discovery, baseline and candidate run IDs;
- target and holdout case IDs;
- repeat count and thresholds;
- paired deltas, mean delta and confidence lower bound;
- holdout delta;
- model and evaluation metadata from the persisted OpenMythos runs;
- corpus and oracle hashes produced by OpenMythosEvalService;
- configured Git SHA when supplied by the runtime;
- final promotion decision.

## Simplification

SelfModificationPipeline delegates coverage discovery to
SelfCodeAnalysisService. Dead random experiment services are deleted. The
SEGML L5 mutation endpoint is retired rather than wrapped in another layer;
clients use `/api/governance-feedback/run`.
