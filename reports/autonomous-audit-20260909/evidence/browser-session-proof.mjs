import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const result = name => {
  const log = readFileSync(new URL(name, import.meta.url), 'utf8');
  return JSON.parse(log.match(/### Result\n([\s\S]*?)\n### Ran/)[1]);
};
const initial = result('browser-session-initial.log');
assert.equal(initial.access_ttl, 20);
assert.equal(initial.expired, true);
assert.equal(initial.refresh_cookie_visible_to_js, false);
assert.deepEqual(initial.cookies, [{ name: 'djimitflo_refresh', httpOnly: true, secure: false, sameSite: 'Strict', path: '/api/auth' }]);
const db = new Database(new URL('../../../.data/audit.sqlite', import.meta.url).pathname, { readonly: true, fileMustExist: true });
try {
  const records = db.prepare('SELECT session_id, user_id, revoked, issued_at, expires_at, rotated_from IS NOT NULL AS rotated FROM refresh_tokens WHERE session_id=? ORDER BY rowid').all(initial.sid);
  assert(records.length >= 2);
  assert(records.every(row => row.user_id === initial.user && row.session_id === initial.sid));
  assert.equal(records[0].rotated, 0);
  assert(records.slice(1).every(row => row.rotated === 1));
  const audit = db.prepare("SELECT id, action, metadata FROM audit_events WHERE user_id=? AND action IN ('auth.login','auth.refresh','auth.logout','organization.switch') AND timestamp>=? ORDER BY rowid")
    .all(initial.user, records[0].issued_at);
  const switched = result('browser-session-switch-proof.log');
  assert.equal(switched.sid, initial.sid);
  assert.equal(switched.organization, 'default');
  assert.equal(switched.selected, 'default');
  assert.equal(switched.api_me_status, 200);
  assert.equal(switched.body_errors, false);
  const wire = readFileSync(new URL('browser-session-switch-requests.log', import.meta.url), 'utf8');
  assert(wire.includes('/api/organizations/switch => [401]'));
  assert(wire.includes('/api/auth/refresh => [200]'));
  assert(wire.includes('/api/organizations/switch => [200]'));
  if (process.argv.includes('--final')) {
    const tabs = result('browser-session-multitab-proof.log');
    assert.equal(tabs.before.expired, true);
    assert.equal(tabs.after.length, 2);
    assert(tabs.after.every(tab => tab.sid === initial.sid && tab.organization === 'default' && tab.api_me_status === 200 && tab.webLocks));
    const before = JSON.parse(readFileSync(new URL('browser-session-db-before.json', import.meta.url), 'utf8'));
    const after = JSON.parse(readFileSync(new URL('browser-session-db-after-tabs.json', import.meta.url), 'utf8'));
    assert.equal(after.records.length, before.records.length + 1);
    assert.equal(after.records.filter(row => row.revoked === 0).length, 1);
    assert.equal(after.audit.filter(row => row.action === 'auth.refresh').length, before.audit.filter(row => row.action === 'auth.refresh').length + 1);
    assert(records.every(row => row.revoked === 1), 'Logout must durably revoke every generation');
    const restart = result('browser-session-restart-proof.log');
    assert.equal(restart.sid, initial.sid);
    assert.equal(restart.organization, 'default');
    assert.equal(restart.api_me_status, 200);
    assert.equal(restart.access_ttl, 900);
    const logout = result('browser-session-logout-proof.log');
    assert.equal(logout.access_token_present, false);
    assert.equal(logout.refresh_cookie_present, false);
    assert.equal(logout.previously_valid_token_status, 401);
    assert.equal(logout.tabs.length, 2);
    assert(logout.tabs.every(tab => tab.route === '/login' && !tab.access_token_present));
    assert(audit.some(row => row.action === 'auth.logout'));
  } else assert.equal(records.filter(row => row.revoked === 0).length, 1);
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), sid: initial.sid, records, audit, final_logout_asserted: process.argv.includes('--final'), production_verified: false }, null, 2));
} finally { db.close(); }
