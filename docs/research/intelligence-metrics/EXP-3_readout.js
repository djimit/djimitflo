const D=require('better-sqlite3');const d=new D('/data/djimitflo.sqlite',{readonly:true});d.pragma('query_only=1');
const START='2026-10-08T00:00:00.000Z', STOP='2026-10-27T00:00:00.000Z';
const nonMaker=r=>`EXISTS (SELECT 1 FROM judgments oa WHERE oa.judgment='outcome_attribution' AND oa.decision IN ('reviewer_failure','environment_failure') AND ((oa.subject_type='loop_run' AND oa.subject_id=${r}) OR (oa.subject_type='self_improvement' AND EXISTS (SELECT 1 FROM loop_runs oar JOIN goals oag ON oag.id=oar.goal_id WHERE oar.id=${r} AND oag.improvement_id=oa.subject_id AND oar.created_at<=oa.created_at))))`;
const rows=d.prepare(`SELECT DISTINCT e.loop_run_id run, r.goal_id goal, s.id imp, s.status status, s.evidence_refs_json refs,
  CASE WHEN json_extract(e.metadata,'$.memory_holdout')=1 THEN 'holdout' ELSE 'rules' END arm, ${nonMaker('e.loop_run_id')} AS nonmaker,
  EXISTS (SELECT 1 FROM worker_leases fl WHERE fl.loop_run_id=e.loop_run_id AND json_extract(fl.metadata,'$.runtime_fallback') IS NOT NULL) AS fb
  FROM loop_events e JOIN loop_runs r ON r.id=e.loop_run_id JOIN goals g ON g.id=r.goal_id JOIN self_improvements s ON s.id=g.improvement_id
  WHERE e.event_type='assignment_context' AND e.created_at>=? AND e.created_at<? AND s.status IN ('verified','regressed')
  AND (json_extract(e.metadata,'$.memory_holdout')=1 OR json_array_length(json_extract(e.metadata,'$.rule_ids'))>0)`).all(START,STOP);
const lane=x=>(x||'').includes('"mutation-gap:')?'mutation':(x||'').includes('"test-gap:')?'test-gap':'other';
const kept=rows.filter(r=>!r.fb && !(r.status==='regressed'&&r.nonmaker));
const excl={nonmaker_regressed:rows.filter(r=>!r.fb&&r.status==='regressed'&&r.nonmaker).length,fallback:rows.filter(r=>r.fb).length};
function table(units){const t={};for(const u of units){const L=u.lane;t[L]=t[L]||{rules:[0,0],holdout:[0,0]};t[L][u.arm][u.v?0:1]++}return t}
function cmh(t){let num=0,varr=0,R=0,Sx=0;for(const L in t){const [a,b]=t[L].rules,[c,dd]=t[L].holdout;const n=a+b+c+dd;if(n<2)continue;const n1=a+b,n0=c+dd,m1=a+c,m0=b+dd;if(!n1||!n0||!m1||!m0)continue;const E=n1*m1/n;const V=n1*n0*m1*m0/(n*n*(n-1));num+=a-E;varr+=V;R+=a*dd/n;Sx+=b*c/n}
 const chi=varr?(Math.abs(num)-0.5)**2/varr:null; // continuity-corrected
 const z=varr?num/Math.sqrt(varr):null; const pnorm=x=>{const t=1/(1+0.2316419*Math.abs(x)),dd=0.3989423*Math.exp(-x*x/2);let p=dd*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p};
 const p2=chi==null?null:2*(1-pnorm(Math.sqrt(chi)));return {mh_or:Sx?+(R/Sx).toFixed(3):null,chi2_cc:chi==null?null:+chi.toFixed(3),p_two_sided:p2==null?null:+p2.toFixed(4),p_one_sided_rules_better:z==null?null:+(1-pnorm(z)).toFixed(4)}}
const runUnits=kept.map(r=>({lane:lane(r.refs),arm:r.arm,v:r.status==='verified'}));
// sensitivity: one unit per goal (arm is per goal); conflicting arms within a goal reported
const g={};for(const r of kept){const k=r.goal;(g[k]=g[k]||[]).push(r)}
let mixed=0;const goalUnits=Object.values(g).map(rs=>{const arms=new Set(rs.map(x=>x.arm));if(arms.size>1)mixed++;return {lane:lane(rs[0].refs),arm:rs[0].arm,v:rs[0].status==='verified'}});
const tot=u=>{const o={rules:[0,0],holdout:[0,0]};for(const x of u)o[x.arm][x.v?0:1]++;return o};
console.log(JSON.stringify({window:[START,STOP],raw_rows:rows.length,excluded:excl,
 registered_run_level:{totals:tot(runUnits),by_lane:table(runUnits),cmh:cmh(table(runUnits))},
 sensitivity_goal_level:{goals:goalUnits.length,mixed_arm_goals:mixed,totals:tot(goalUnits),by_lane:table(goalUnits),cmh:cmh(table(goalUnits))}},null,1));
