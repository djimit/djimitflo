import assert from 'node:assert/strict';
import { redact } from './assurance-truth.mjs';

assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
assert.equal(redact('api_key=supersecret'), 'api_key=[REDACTED]');
assert.equal(redact('password: hunter2'), 'password: [REDACTED]');
console.log('assurance redaction: pass');
