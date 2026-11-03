# Egress classification (UX-20, shadow)

Where do Djimitflo's server-side model calls send data, and what would a stricter routing rule block? This is a
**report only**: `services/egress-classification.ts` classifies the provider recorded for every call in
`llm_model_calls` (UX-18) and the evidence endpoint (`GET /api/health/evolution-evidence`, section `egress`) shows the
counts. Nothing on a request path calls it; no call is blocked, rerouted or changed.

This document is information for validation by the operator's legal and security function. It is not legal advice.

## Destination classes

| Class | Meaning |
|---|---|
| `local` | Self-hosted: loopback, RFC 1918 private ranges, the CGNAT range Tailscale uses, `*.local`, `*.internal`, `*.ts.net` |
| `eu_hosted` | A provider contractually and physically in the EU (none recorded yet) |
| `us_cloud` | A provider operated by a US company |
| `unknown` | Anything not verified — never guessed |

## Provider table

| Destination | Class | Evidence |
|---|---|---|
| `ollama.com` (Ollama Cloud) | us_cloud | Operated by Ollama Inc. (US company); hosting region not verified |
| `integrate.api.nvidia.com` | us_cloud | NVIDIA API catalog (NVIDIA Corp., US); hosting region not verified |
| `api.openai.com` | us_cloud | OpenAI (US company) |
| `api.anthropic.com` | us_cloud | Anthropic (US company) |
| `openrouter.ai` | us_cloud | OpenRouter (US company); routes to further providers |
| `generativelanguage.googleapis.com` | us_cloud | Google Gemini API (US company) |
| `api.typesafe.ai` (jev) | unknown | Operator jurisdiction and hosting region not verified |
| Workstation llama-router / LiteLLM / local Ollama | local | Self-hosted, reached over the private network or tailnet |

How a recorded call is resolved:
- the provider is an endpoint id with a URL (`ollama:<url>`, `openai:<url>`) → the URL's host;
- a named provider (`nvidia`, `typesafe`) → its fixed host;
- a runtime name (`openai-compatible`, `ollama`, `embedding-provider`) → the host of the configured base URL
  (`SOCIAL_COMPAT_BASE_URL`, `OLLAMA_URL`, `EMBEDDING_BASE_URL`), else unknown;
- no provider but a `:cloud` model (panel review) → Ollama Cloud.

## Assumed data class per consumer

| Consumer | Assumed class | Why |
|---|---|---|
| `frontier_experts` | public | Public papers and repositories |
| `content_safety` | internal | Untrusted inbound text: agent messages, discoveries, KB pages |
| `embeddings` | internal | Proposal and KB text |
| `panel_review` | internal | Proposal text with file paths, no diffs |
| `fallback`, `council`, `resident:*` | internal | Agent messages and generated text |
| `jev` | confidential | Judgment states include `checker_second_opinion` with source diffs |
| any other consumer | confidential | Conservative default |

## V2 routing rule (not wired)

`checkProviderRoutingV2(dataClass, destinationClass)` sits beside the existing `checkProviderRouting`, which is unchanged
and still lists `openai` and `anthropic` under `private_only`:

| Data class | Routing | Allowed destinations |
|---|---|---|
| public, internal | any | all |
| confidential | private_only | local, eu_hosted |
| restricted | on_premise_only | local |

The evidence section's `would_block_v2` counts, per data class, how many calls of the last 7 days V2 would have refused.

## Open questions for the operator

1. **Jurisdiction per provider:** confirm or correct each row above. In particular jev (`api.typesafe.ai`): where is it
   operated and hosted? Is there a data processing agreement?
2. **Data classes:** are the assumed classes per consumer right? Should `panel_review` be confidential (it sees proposal
   text about the codebase)?
3. **What may leave:** which data classes may go to a US cloud at all, given the public-sector context, CLOUD Act
   exposure, the GDPR transfer basis and the EU AI Act logging obligations?
4. **Enforcement:** if V2 should act, from which date, and what happens to a blocked call (fail closed, or fall back to a
   local model)? Enforcement is a separate, operator-approved change.
