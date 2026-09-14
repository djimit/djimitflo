# Spec delta: federation

## ADDED Requirements

### Requirement: PII-pass op externe commons-payloads
The system SHALL apply a configurable PII-pass to external Agent Commons payloads with modes BLOCK, REDACT, HASH, and PASS. The pass SHALL be fail-closed (unknown or ambiguous content resolves to REDACT at minimum) and SHALL be applied in addition to existing write-time secret redaction.

#### Scenario: PII detected with REDACT
- **GIVEN** an external payload containing an e-mail address
- **WHEN** the PII-pass runs in REDACT mode
- **THEN** the e-mail is replaced by a redaction marker and the rest of the payload is preserved

#### Scenario: Fail-closed on unknown
- **GIVEN** a payload whose classification is ambiguous
- **WHEN** the PII-pass runs
- **THEN** the payload is redacted rather than passed through

#### Scenario: Existing secret redaction unchanged
- **GIVEN** a payload with a secret and PII
- **WHEN** write-time secret redaction and the PII-pass both run
- **THEN** both are removed without conflicting with each other

### Requirement: Federation gateway discovery
The system SHALL discover the federation gateway via `GET {base}/.well-known/oauth-protected-resource/mcp` and SHALL validate the returned `resource`, `authorization_servers`, and `scopes_supported` before use. Discovery SHALL be fail-closed.

#### Scenario: Valid discovery
- **GIVEN** the well-known endpoint returns valid metadata
- **WHEN** discovery runs
- **THEN** the adapter uses only the discovered resource URL and authorization server

#### Scenario: Missing field
- **GIVEN** the well-known response lacks `authorization_servers`
- **WHEN** discovery runs
- **THEN** the adapter rejects and does not contact any endpoint

#### Scenario: Network failure
- **GIVEN** the well-known endpoint is unreachable
- **WHEN** discovery runs
- **THEN** discovery fails closed with an explicit reason and no fallback URL is contacted

### Requirement: Federation is feature-flagged
The system SHALL keep federation disabled unless `DJIMITFLO_FEDERATION_ENABLED` is set. When disabled, federation codepaths SHALL be no-ops and existing internal commons behavior SHALL be unchanged.

#### Scenario: Flag absent
- **GIVEN** `DJIMITFLO_FEDERATION_ENABLED` is not set
- **WHEN** a federation operation is invoked
- **THEN** it is a no-op and internal commons behavior is identical to before this change
