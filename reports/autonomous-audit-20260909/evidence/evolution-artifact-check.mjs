import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const json=name=>JSON.parse(read(name));
function browser(name){const match=read(name).match(/### Result\n([\s\S]*?)\n### Ran/);assert(match,`Missing actual browser result ${name}`);return JSON.parse(match[1]);}
const summary=json('verification-summary.json');
const suite=[...read('evolution-tests-frozen.log').matchAll(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/g)];
assert.equal(suite.length,7);assert.equal(suite.reduce((sum,m)=>sum+Number(m[1]),0),2696);assert.equal(suite.reduce((sum,m)=>sum+Number(m[2]??0),0),20);
assert.equal(summary.checks.tests.passed,2696);assert.equal(summary.mission_complete,false);
assert.equal(json('assurance-evolution.json').status,'blocked');
const routes=json('route-runtime-registration-all-auth.json');assert.equal(routes.routes.length,610);assert.equal(routes.auth_http_probes.length,604);assert(routes.auth_http_probes.every(p=>p.status===401));
assert.deepEqual(routes.comparison,{declared_not_registered:[],registered_not_declared:[],unsupported_source:[]});
const before=json('evolution-http-before.json'),after=json('evolution-http-after-restart.json');
assert.equal(before.state,'PASS');assert.equal(after.state,'PASS');assert.equal(before.strategy.id,after.strategy.id);assert.equal(after.strategy.episodeCount,10);assert.equal(after.strategy.successRate,0.5);assert.equal(after.strategy.conditions.causal_support,false);assert.deepEqual(after.goals,before.goals);
const negative=json('evolution-loop-negative-control-final.json');assert.equal(negative.state,'PASS');assert.equal(negative.checks.checks[0].exit_status,1);assert.equal(negative.closure.status,'blocked');assert.equal(negative.closure.eval_run,null);assert.equal(negative.providerExecuted,false);
const outage=browser('browser-evolution-cognitive-outage.log');assert(outage.retryVisible&&outage.emptyStateHidden);
const restarted=browser('browser-evolution-cognitive-restarted.log');assert.equal(restarted.sampleSize,1);assert.equal(restarted.rate,1);assert(restarted.advisoryOnly);
const network=browser('browser-evolution-cognitive-network-revalidated.log');assert.deepEqual(network.errors,[]);assert.deepEqual(network.failed,[]);assert.equal(network.responses.filter(r=>r.url.includes('/api/cognitive/')).length,2);assert(network.responses.every(r=>r.status===200));assert(network.consoleErrors.every(message=>message.includes('data:,')));
const db=new Database(new URL('../../../.data/audit.sqlite',import.meta.url).pathname,{readonly:true});
let persisted;
try {
  const episodes=db.prepare('SELECT COUNT(*) n,COUNT(DISTINCT loop_run_id) distinct_n,AVG(outcome=\'success\') rate FROM cognitive_episodes WHERE goal_type=?').get(after.goalType);
  assert.deepEqual(episodes,{n:10,distinct_n:10,rate:0.5});
  const run=db.prepare('SELECT status FROM loop_runs WHERE id=?').get(negative.runId);assert.equal(run.status,'blocked');
  const maker=db.prepare('SELECT status FROM worker_leases WHERE id=?').get(negative.maker.id);assert.equal(maker.status,'failed');
  const closures=db.prepare('SELECT COUNT(*) n FROM loop_learning_closures WHERE loop_run_id=?').get(negative.runId);assert.equal(closures.n,0);
  persisted={episodes,negative_loop_status:run.status,maker_status:maker.status,learning_closures:closures.n};
} finally {db.close();}
const files=['evolution-tests-frozen.log','evolution-build-final.log','evolution-server-build-integrated.log','evolution-typecheck-frozen.log','evolution-lint-frozen.log','evolution-mutation.log','route-runtime-registration-all-auth.json','evolution-http-before.json','evolution-http-after-restart.json','evolution-loop-negative-control-final.json','browser-evolution-cognitive-network-revalidated.log'];
const hashes=Object.fromEntries(files.map(name=>[name,createHash('sha256').update(read(name)).digest('hex')]));
console.log(JSON.stringify({state:'PASS',recorded_at:new Date().toISOString(),tests:2696,skipped:20,registered_api_routes:610,anonymous_auth_denials:604,goal_statuses:after.goals,persisted,console_noise:'Only retained automation-origin data: CSP messages; no page exceptions or failing cognitive requests in final capture',hashes,mission_complete:false,unseen_task_improvement_proven:false,strategy_applied:false,background_monitor_active:false},null,2));
