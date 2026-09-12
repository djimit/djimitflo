# G252 SEGML production-cycle truth repair

The production-cycle service previously conflated score improvement with an
actual deployment and also used a non-existent `status` column when recording
an Ollama adapter. The shared service now:

- records successful adapter creation against the actual schema;
- stores a cycle `adapter_id` only when adapter creation actually succeeded;
- returns `promotionEligible` separately from `deployed`;
- keeps `deployed=false` and persists `deployed=0` until an approved observable
  deployment executor exists;
- reports an explicit `deploymentReason`.

Focused SEGML service/route tests pass **11/11** using a disposable provider
fixture that returns a genuine above-threshold comparison. The fixture proves
adapter persistence, null provenance on failed creation and prevents a false
deployment claim; it is not provider quality or production-promotion evidence.
