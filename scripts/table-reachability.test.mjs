import assert from 'node:assert/strict';
import { hasSqlRead } from './table-reachability.mjs';

assert.equal(hasSqlRead('DELETE FROM audit_events WHERE id = ?', 'audit_events'), false);
assert.equal(hasSqlRead('delete \n from "audit_events" WHERE id = ?', 'audit_events'), false);
assert.equal(hasSqlRead('INSERT INTO audit_events (id) VALUES (?)', 'audit_events'), false);
assert.equal(hasSqlRead('UPDATE audit_events SET id = ?', 'audit_events'), false);
assert.equal(hasSqlRead('SELECT * FROM audit_events', 'audit_events'), true);
assert.equal(hasSqlRead('SELECT * FROM tasks JOIN audit_events ON tasks.id = audit_events.task_id', 'audit_events'), true);
assert.equal(hasSqlRead('DELETE FROM tasks WHERE id IN (SELECT task_id FROM audit_events)', 'audit_events'), true);
assert.equal(hasSqlRead('DELETE FROM tasks WHERE id IN (SELECT task_id FROM audit_events)', 'tasks'), false);
assert.equal(hasSqlRead('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events)', 'audit_events'), true);
assert.equal(hasSqlRead('SELECT * FROM audit_events_archive', 'audit_events'), false);
console.log('table-reachability SQL read classification assertions passed');
