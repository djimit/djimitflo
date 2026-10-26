// Existing deployed read-only report functions, not proposed branch logic. Process-local counters are not exported.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {buildEvolutionEvidence} from '/app/packages/server/dist/services/evolution-evidence.js';
import {efficiencyWithCost} from '/app/packages/server/dist/services/cost-ledger.js';
const db=new Database('/data/djimitflo.sqlite',{readonly:true});db.pragma('query_only=ON');db.exec('BEGIN');
const now=Date.now(),r=buildEvolutionEvidence(db,process.env,now,30), reports={};
for(const k of ['merge','drafts','genomes','gym','gym_prod_gates','trials','models','oracle','commons','forecasts_v2','estimates','ope','holdout_exposure','runtime_fallback','inference','effort_x1','checker_family','graded','fail_before_pass_after','knowledge_links','knowledge_gaps','negative_evidence','gate_rule_disagreements','falsifier','settlement_execution','gates','maker_tokens']){
  if(k in r)reports[k]=r[k];
}
reports.efficiency=efficiencyWithCost(db,now,process.env,7);
assert.equal(db.pragma('query_only',{simple:true}),1);db.exec('COMMIT');db.close();
console.log(JSON.stringify({captured_at:new Date(now).toISOString(),source_sha:process.env.DJIMITFLO_COMMIT_SHA,mode:'readonly + query_only',keys_available:Object.keys(r),reports},null,2));
