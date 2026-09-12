import assert from 'node:assert/strict';
import { expectedDatabaseInstance, verifyIdentity } from './live-identity-evidence.mjs';

const commit = 'a'.repeat(40);
const input = {
  commit, dirty: false, instanceId: 'instance-test', localInstanceId: 'instance-test',
  health: { ok: true, body: { status: 'healthy', commit } },
  version: { ok: true, body: { version: '0.5.8' } },
  provenance: { ok: true, body: { database: { commit_sha: commit, mode: 'live', instance_id: 'instance-test' } } },
  integrity: { ok: true, output: 'ok' },
};
assert.equal(verifyIdentity(input), true);
assert.deepEqual(expectedDatabaseInstance({ baseUrl: 'http://127.0.0.1:3001', localInstanceId: 'local-db' }), {
  instanceId: 'local-db', source: 'local_database',
});
assert.deepEqual(expectedDatabaseInstance({ baseUrl: 'https://djimitflo.example', localInstanceId: 'unrelated-local-db' }), {
  instanceId: '', source: 'missing_explicit_configuration',
});
assert.deepEqual(expectedDatabaseInstance({ baseUrl: 'https://djimitflo.example', configuredId: ' prod-db ', localInstanceId: 'unrelated-local-db' }), {
  instanceId: 'prod-db', source: 'configured',
});
for (const override of [
  { dirty: true }, { instanceId: '' }, { instanceId: 'other-db' }, { commit: 'b'.repeat(40) },
  { localInstanceId: 'unrelated-local-db' },
  { health: { ok: true, body: null } }, { health: { ok: true, body: { status: 'healthy', commit: 'b'.repeat(40) } } },
  { version: { ok: true, body: null } }, { integrity: { ok: true, output: 'corrupt' } },
  { provenance: { ok: true, body: {} } }, { provenance: { ok: false, body: input.provenance.body } },
  { provenance: { ok: true, body: { database: { ...input.provenance.body.database, mode: 'demo' } } } },
  { provenance: { ok: true, body: { database: { ...input.provenance.body.database, commit_sha: 'b'.repeat(40) } } } },
]) assert.equal(verifyIdentity({ ...input, ...override }), false, JSON.stringify(override));
console.log('live identity rejects missing/mismatched provenance and HTTP-only false positives: pass');
