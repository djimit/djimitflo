# Legal RuleOps route proof — G298

The authenticated local HTTP fixture now exercises the remaining legal read/classification surface: `/legal/classify` detects PII without anonymizing, `/legal/rechtsgebied/:ecli` maps an ECLI to `cassatie`, and `/legal/status` returns the engine version and persisted feedback count. Focused legal route suite passes 3/3, while malformed PII/feedback inputs remain 400 and side-effect-free.

This is deterministic local legal-rule evidence, not legal advice, production publication or external legal-source validation.
