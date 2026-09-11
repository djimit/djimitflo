import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const json=name=>JSON.parse(read(name));
const reports=['SYSTEM_MAP','CAPABILITY_MATRIX','UI_FUNCTION_MATRIX','RUNTIME_MATRIX','GAP_REGISTER','AUTONOMY_REPORT','ASTRA_INTEGRATION','VERIFICATION_REPORT','FINAL_STATE'];
for(const name of reports){const content=read(`../${name}.md`);assert(content.length>100,name);assert(!/integration pending|gates[^.\n]*pending|pending the parent checkpoint/i.test(content.slice(0,700)),`${name}: stale current checkpoint`);}
const counts=[...read('lifecycle-tests-final.log').matchAll(/Tests\s+(\d+) passed(?: \| (\d+) skipped)?/g)];
assert.equal(counts.length,7);const passed=counts.reduce((sum,row)=>sum+Number(row[1]),0);const skipped=counts.reduce((sum,row)=>sum+Number(row[2]||0),0);
const summary=json('verification-summary.json');assert.equal(summary.mission_complete,false);assert.equal(summary.merge_status,'REVIEW_REQUIRED');assert.equal(summary.checks.tests.passed,passed);assert.equal(passed,2656);assert.equal(skipped,20);
assert(!/Tests\s+\d+ failed/.test(read('lifecycle-tests-final.log')));
assert(read('approval-range-mutation-final.log').includes('71'));assert(read('lifecycle-assurance-scripts.log').includes('# pass 11'));
const assurance=json('assurance-lifecycle.json');assert.equal(assurance.status,'blocked');assert(assurance.gates.every(c=>['pass','blocked','skipped'].includes(c.status)));
const proof=json('lifecycle-browser-proof.json');assert.equal(proof.state,'PASS');assert.equal(proof.providerExecuted,false);
const http=json('lifecycle-http-after-restart.json');assert.equal(http.reviewGrantCount,2);assert(http.reviewGrantTimestampsMatchCanonical);
for(const name of ['browser-lifecycle-agent-pending-final.log','browser-lifecycle-agent-final.log','browser-lifecycle-review-final.log'])assert(!read(name).includes('### Error'),name);
console.log(JSON.stringify({state:'PASS',reports:reports.length,passed,skipped,missionComplete:false,assurance:assurance.status,browserProof:proof.state,reviewGrantTimestampsMatchCanonical:true},null,2));
