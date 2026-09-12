import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const dbPath = new URL('../../../.data/audit.sqlite', import.meta.url).pathname;
assert.equal(dbPath, '/Users/dlandman/djimitflo-audit-20260909/.data/audit.sqlite');
const setup = process.argv[2] === 'setup-organization-fixture';
const db = new Database(dbPath, { readonly: !setup, fileMustExist: true });
try {
  if (setup) {
    const { AuthService } = await import('../../../packages/server/dist/services/auth-service.js');
    const service = new AuthService(db);
    const email = 'audit-org-20260909@example.test';
    assert.equal(service.findUserByEmail(email), null, 'Do not overwrite an existing fixture identity');
    db.transaction(() => {
      db.prepare('INSERT INTO organizations (id,name) VALUES (?,?)').run('audit-org-20260909', 'Audit Organization Fixture');
      service.createUser(email, 'disposable-organization-fixture-only', 'admin', 'audit-org-20260909');
    })();
    console.log(JSON.stringify({ organization_fixture_created: true, external_effects: false }));
  } else if (process.argv[2] === 'organization') {
    const user = db.prepare('SELECT id,organization_id FROM users WHERE email=?').get('audit-org-20260909@example.test');
    assert.equal(user.organization_id, 'audit-org-20260909');
    const audit = db.prepare("SELECT action,user_id,metadata FROM audit_events WHERE user_id=? AND action='organization.switch' ORDER BY rowid").all(user.id);
    assert.deepEqual(audit.map(row => JSON.parse(row.metadata)), [
      { from: 'audit-org-20260909', to: 'default' }, { from: 'default', to: 'audit-org-20260909' },
    ]);
    const observations = ['default', 'return'].map(stage => {
      const log = readFileSync(new URL(`organization-browser-${stage}-proof.log`, import.meta.url), 'utf8');
      const observed = JSON.parse(log.match(/### Result\n([\s\S]*?)\n### Ran/)[1]);
      assert.equal(observed.selected, stage === 'default' ? 'default' : 'audit-org-20260909');
      assert.equal(observed.stored_token_organization, observed.selected);
      assert.deepEqual(observed.options.sort(), ['audit-org-20260909', 'default']);
      return observed;
    });
    console.log(JSON.stringify({ observations, durable_membership: user.organization_id, audit, proof: 'actual browser switch and return, full reload, replacement token scope and canonical audit', tenant_row_isolation_verified: false }, null, 2));
  } else {
    const id = 'a67c8f37-56cc-4232-8d5b-79639bdb6130';
    const item = db.prepare('SELECT id,status,parent_goal_id FROM work_items WHERE id=?').get(id);
    assert.equal(item.status, 'planned');
    assert.equal(item.parent_goal_id, '515f7687-f130-47de-a2fb-5d972c8f5eb3');
    const goals = db.prepare("SELECT id,status FROM goals WHERE json_extract(metadata,'$.source_work_item_id')=?").all(id);
    assert.deepEqual(goals, [{ id: item.parent_goal_id, status: 'created' }]);
    const loops = db.prepare('SELECT id FROM loop_runs WHERE goal_id=?').all(item.parent_goal_id);
    assert.equal(loops.length, 0);
    const ui = readFileSync(new URL('work-item-browser-reloaded.log', import.meta.url), 'utf8');
    assert(ui.includes(item.parent_goal_id));
    assert(ui.includes('button "Goal" [disabled]'));
    console.log(JSON.stringify({ work_item: item, goals, loop_runs: loops, proof: 'browser conversion, duplicate API request, reload and independent file-SQLite assertions', provider_execution: false }, null, 2));
  }
} finally { db.close(); }
