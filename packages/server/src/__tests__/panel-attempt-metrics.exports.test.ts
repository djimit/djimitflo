import { describe, expect, it } from 'vitest';
import { quarantineState, ledgerState, PARSE_OR_SCHEMA } from '../services/panel-attempt-metrics';

describe('quarantineState', () => {
  it('classifies an empty model response as GENERATION_FAILED', () => {
    expect(quarantineState('generation failed: empty model response')).toBe('GENERATION_FAILED');
  });

  it('classifies an empty model response with trailing detail as GENERATION_FAILED', () => {
    expect(quarantineState('generation failed: empty model response after 3 retries')).toBe('GENERATION_FAILED');
  });

  it('classifies a non-empty generation failure as INFRA_FAILED', () => {
    expect(quarantineState('generation failed: connection reset by peer')).toBe('INFRA_FAILED');
  });

  it('classifies a timeout-style generation failure as INFRA_FAILED', () => {
    expect(quarantineState('generation failed: provider returned 500')).toBe('INFRA_FAILED');
  });

  it('classifies a parse error ("no JSON object in the answer") as PARSE_FAILED', () => {
    expect(quarantineState('no JSON object in the answer')).toBe('PARSE_FAILED');
  });

  it('classifies a parse error ("answer is not valid JSON") as PARSE_FAILED', () => {
    expect(quarantineState('answer is not valid JSON')).toBe('PARSE_FAILED');
  });

  it('classifies a parse error ("answer is not a JSON object") as PARSE_FAILED', () => {
    expect(quarantineState('answer is not a JSON object')).toBe('PARSE_FAILED');
  });

  it('classifies a schema error as SCHEMA_INVALID', () => {
    expect(quarantineState('stance must be one of support|oppose|uncertain|needs_evidence (got null)')).toBe('SCHEMA_INVALID');
  });

  it('classifies a confidence schema error as SCHEMA_INVALID', () => {
    expect(quarantineState('confidence must be a number between 0 and 1')).toBe('SCHEMA_INVALID');
  });

  it('classifies unrecognised error text as QUARANTINED (cause unknown)', () => {
    expect(quarantineState('something completely unexpected happened')).toBe('QUARANTINED');
  });

  it('classifies empty string as QUARANTINED', () => {
    expect(quarantineState('')).toBe('QUARANTINED');
  });
});

describe('ledgerState', () => {
  it('maps "ok" to VALID_FIRST_PASS', () => {
    expect(ledgerState('ok')).toBe('VALID_FIRST_PASS');
  });

  it('maps "repaired" to VALID_AFTER_RETRY', () => {
    expect(ledgerState('repaired')).toBe('VALID_AFTER_RETRY');
  });

  it('maps "invalid_parse" to PARSE_FAILED', () => {
    expect(ledgerState('invalid_parse')).toBe('PARSE_FAILED');
  });

  it('maps "invalid_schema" to SCHEMA_INVALID', () => {
    expect(ledgerState('invalid_schema')).toBe('SCHEMA_INVALID');
  });

  it('maps legacy "invalid" to PARSE_OR_SCHEMA combined class', () => {
    expect(ledgerState('invalid')).toBe(PARSE_OR_SCHEMA);
    expect(ledgerState('invalid')).toBe('PARSE_FAILED|SCHEMA_INVALID');
  });

  it('maps "empty" to GENERATION_FAILED', () => {
    expect(ledgerState('empty')).toBe('GENERATION_FAILED');
  });

  it('maps "error" to INFRA_FAILED', () => {
    expect(ledgerState('error')).toBe('INFRA_FAILED');
  });

  it('maps null status to UNKNOWN_FAILURE', () => {
    expect(ledgerState(null)).toBe('UNKNOWN_FAILURE');
  });

  it('maps an unrecognised status to UNKNOWN_FAILURE', () => {
    expect(ledgerState('something-new')).toBe('UNKNOWN_FAILURE');
  });

  it('maps empty string status to UNKNOWN_FAILURE', () => {
    expect(ledgerState('')).toBe('UNKNOWN_FAILURE');
  });
});