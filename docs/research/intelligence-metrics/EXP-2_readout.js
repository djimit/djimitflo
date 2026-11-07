// X1 (EXP-2) readout, read-only. Population = effortX1Evidence's: goals with metadata.effort_arm in (on,off), no lease on the
// Ollama outage fallback; settled = proposal verified|regressed; registered test = two-sided Fisher exact on verified/settled.
// Horizon: goals created [2026-10-09T00:00Z, 2026-11-06T00:00Z) (registered stop_by). Timestamps normalised with julianday().
const D=require('better-sqlite3');const d=new D('/data/djimitflo.sqlite',{readonly:true});d.pragma('query_only=1');
const START='2026-10-09T00:00:00Z', STOP='2026-11-06T00:00:00Z';
const B947a='2026-10-22T00:00:00Z', B947b='2026-10-29T17:13:27Z', MEM='2026-10-27T05:52:42Z', PROMPT='2026-11-05T19:58:00Z';
const jd=s=>Date.parse(s);
const notFb=`NOT EXISTS (SELECT 1 FROM loop_runs fr JOIN worker_leases fl ON fl.loop_run_id = fr.id WHERE fr.goal_id = g.id AND json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL)`;
const goals=d.prepare(`SELECT g.id, g.created_at, json_extract(g.metadata,'$.effort_arm') arm, s.status, s.evidence_refs_json refs, ${notFb} AS nofb
  FROM goals g LEFT JOIN self_improvements s ON s.id=g.improvement_id WHERE json_extract(g.metadata,'$.effort_arm') IN ('on','off')`).all()
  .map(g=>({...g, t: jd(g.created_at.includes('T')?g.created_at:g.created_at.replace(' ','T')+'Z')}));
const inH=g=>g.t>=jd(START)&&g.t<jd(STOP);
const lane=x=>(x||'').includes('"mutation-gap:')?'mutation':(x||'').includes('"test-gap:')?'test-gap':'other';
// ---- stats
const lf=(()=>{const c=[0];for(let i=1;i<2000;i++)c[i]=c[i-1]+Math.log(i);return n=>c[n]})();
function fisher(a,b,c,dd){const r1=a+b,r2=c+dd,c1=a+c,n=r1+r2;const p=x=>Math.exp(lf(r1)+lf(r2)+lf(c1)+lf(n-c1)-lf(n)-lf(x)-lf(r1-x)-lf(c1-x)-lf(r2-c1+x));
 const p0=p(a);let s=0;for(let x=Math.max(0,c1-r2);x<=Math.min(r1,c1);x++){const px=p(x);if(px<=p0*(1+1e-7))s+=px}return Math.min(1,s)}
const z=1.959964;
function wilson(k,n){if(!n)return[null,null];const p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;return[c-h,c+h]}
function newcombe(k1,n1,k0,n0){const [l1,u1]=wilson(k1,n1),[l0,u0]=wilson(k0,n0),p1=k1/n1,p0=k0/n0,dlt=p1-p0;
 return [dlt-Math.sqrt((p1-l1)**2+(u0-p0)**2), dlt+Math.sqrt((u1-p1)**2+(p0-l0)**2)]}
const pnorm=x=>{const t=1/(1+0.2316419*Math.abs(x)),dd=0.3989423*Math.exp(-x*x/2);let p=dd*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p};
function cmh(strata){let num=0,v=0,R=0,S=0,rdN=0,rdW=0,varRD=0;for(const s of strata){const [a,b]=s.on,[c,dd]=s.off;const n1=a+b,n0=c+dd,n=n1+n0;if(!n1||!n0)continue;const m1=a+c,m0=b+dd;
  if(n>1&&m1&&m0){num+=a-n1*m1/n;v+=n1*n0*m1*m0/(n*n*(n-1));R+=a*dd/n;S+=b*c/n}
  const w=n1*n0/n;rdN+=w*(a/n1-c/n0);rdW+=w; // MH risk difference; Sato variance
  varRD+=(n1*n1*c*dd/n0 + n0*n0*a*b/n1)/(n*n) ; }
 const chi=v?(Math.abs(num)-0.5)**2/v:null;const rd=rdW?rdN/rdW:null;const se=rdW?Math.sqrt(varRD)/rdW:null; // Greenland-Robins-type simple variance
 return {mh_or:S?+(R/S).toFixed(3):null,chi2_cc:chi==null?null:+chi.toFixed(3),p_two_sided:chi==null?null:+(2*(1-pnorm(Math.sqrt(chi)))).toFixed(4),
  mh_rd:rd==null?null:+rd.toFixed(3),mh_rd_ci95:se==null?null:[+(rd-z*se).toFixed(3),+(rd+z*se).toFixed(3)]}}
function cell(gs){const o={on:[0,0],off:[0,0],goals:{on:0,off:0},unsettled:{on:{},off:{}}};for(const g of gs){o.goals[g.arm]++;if(g.status==='verified')o[g.arm][0]++;else if(g.status==='regressed')o[g.arm][1]++;else{const u=o.unsettled[g.arm];u[g.status||'null']=(u[g.status||'null']||0)+1}}return o}
function summarise(gs){const c=cell(gs);const [a,b]=c.on,[cc,dd]=c.off;const n1=a+b,n0=cc+dd;
 return {goals:c.goals,settled:{on:n1,off:n0},verified:{on:a,off:cc},regressed:{on:b,off:dd},rate:{on:n1?+(a/n1).toFixed(3):null,off:n0?+(cc/n0).toFixed(3):null},
  rate_ci95:{on:n1?wilson(a,n1).map(x=>+x.toFixed(3)):null,off:n0?wilson(cc,n0).map(x=>+x.toFixed(3)):null},
  rd_on_minus_off:n1&&n0?+(a/n1-cc/n0).toFixed(3):null, rd_newcombe_ci95:n1&&n0?newcombe(a,n1,cc,n0).map(x=>+x.toFixed(3)):null,
  fisher_p_two_sided:n1&&n0?+fisher(a,b,cc,dd).toPrecision(4):null, not_settled:c.unsettled}}
const base=goals.filter(g=>g.nofb&&inH(g));
const excludedFallback=goals.filter(g=>!g.nofb&&inH(g)).length;
const per=[['P1 pre-#947',START,B947a],['P2a #947 window, memory rules on',B947a,MEM],['P2b #947 window, memory rules off',MEM,B947b],['P3 post-#947 fix',B947b,PROMPT],['P4 post maker-prompt change',PROMPT,STOP]];
const inP=(g,s,e)=>g.t>=jd(s)&&g.t<jd(e);
const periods=per.map(([name,s,e])=>({name,from:s,to:e,...summarise(base.filter(g=>inP(g,s,e)))}));
const strat=gs=>per.map(([n,s,e])=>{const c=cell(gs.filter(g=>inP(g,s,e)));return {on:c.on,off:c.off}});
const no947=base.filter(g=>!(g.t>=jd(B947a)&&g.t<jd(B947b)));
const per947=[per[0],per[3],per[4]];
// ---- siblings: delivery per period (on arm)
const sib=d.prepare(`SELECT r.goal_id gid, l.runtime, l.status, json_extract(l.metadata,'$.model') model, json_extract(l.metadata,'$.failure_reason') fr, l.id FROM worker_leases l JOIN loop_runs r ON r.id=l.loop_run_id
  WHERE l.role='maker' AND json_extract(l.metadata,'$.evolve_sibling_of') IS NOT NULL`).all();
const byG={};for(const s of sib)(byG[s.gid]=byG[s.gid]||[]).push(s);
const selected=d.prepare(`SELECT r.goal_id gid, e.metadata m FROM loop_events e JOIN loop_runs r ON r.id=e.loop_run_id WHERE e.event_type='evolve_selected'`).all();
const selByG={};for(const s of selected){try{selByG[s.gid]=JSON.parse(s.m)}catch{}}
const sibStats=per.map(([name,s,e])=>{const on=base.filter(g=>g.arm==='on'&&inP(g,s,e));const o={on_goals:on.length,with_sibling:0,sibling_leases:0,by_runtime_status:{},sibling_won:0};
 for(const g of on){const L=byG[g.id]||[];if(L.length)o.with_sibling++;for(const l of L){o.sibling_leases++;const k=l.runtime+(l.model?'@'+l.model:'')+':'+l.status;o.by_runtime_status[k]=(o.by_runtime_status[k]||0)+1}
  const sel=selByG[g.id];if(sel&&L.some(l=>l.id===sel.winner_lease_id||l.id===sel.selected_lease_id||l.id===sel.winner))o.sibling_won++}
 return {name,...o}});
const sampleSel=selected.slice(-1).map(s=>s.m.slice(0,400));
// ---- cost per arm (all leases on the goal's runs; cloud = not remote/mock/manual and not a local model server)
const cloud=(rt,m)=>!['remote','mock','manual'].includes(rt)&&!/llama-router|^ollama\/(?!.*:cloud)/.test(m||'');
const leases=d.prepare(`SELECT r.goal_id gid, l.role, l.runtime, json_extract(l.metadata,'$.model') model, json_extract(l.metadata,'$.effective_model') emodel, json_extract(l.metadata,'$.evolve_sibling_of') sibof,
  json_extract(l.metadata,'$.runtime_usage.total_tokens') tok, json_extract(l.metadata,'$.started_at') st, json_extract(l.metadata,'$.completed_at') ct FROM worker_leases l JOIN loop_runs r ON r.id=l.loop_run_id
  WHERE r.goal_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(base.map(g=>g.id)));
const pw=d.prepare(`SELECT at, gpu_watts w FROM host_power_samples WHERE host='workstation' AND at>=? AND at<=? ORDER BY at`);
function kwh(st,ct){if(!st||!ct)return null;const r=pw.all(st,ct);if(r.length<2)return null;let j=0;for(let i=1;i<r.length;i++){const dt=(jd(r[i].at)-jd(r[i-1].at))/1000;if(dt>0&&dt<300)j+=dt*(r[i].w+r[i-1].w)/2}return j/3.6e6}
const goalArm=Object.fromEntries(base.map(g=>[g.id,g]));
function cost(filter){const o={};for(const a of ['on','off']){o[a]={goals:0,leases:0,tokens_total:0,tokens_cloud:0,tokens_unreported_leases:0,maker_primary_tokens:0,sibling_tokens:0,sibling_leases:0,checker_tokens:0,local_lease_gpu_kwh:0,local_leases_with_power:0,local_leases:0}}
 const gs=base.filter(filter);for(const g of gs)o[g.arm].goals++;const ids=new Set(gs.map(g=>g.id));
 for(const l of leases){if(!ids.has(l.gid))continue;const g=goalArm[l.gid];const c=o[g.arm];c.leases++;const t=Number(l.tok)||0;if(!(Number(l.tok)>0)&&['maker','checker','security_checker'].includes(l.role))c.tokens_unreported_leases++;
  c.tokens_total+=t;const m=l.model||l.emodel;if(cloud(l.runtime,m))c.tokens_cloud+=t;
  if(l.role==='maker'){if(l.sibof){c.sibling_tokens+=t;c.sibling_leases++}else c.maker_primary_tokens+=t}else c.checker_tokens+=t;
  if(l.role==='maker'&&!cloud(l.runtime,m)){c.local_leases++;const k=kwh(l.st,l.ct);if(k!=null){c.local_lease_gpu_kwh+=k;c.local_leases_with_power++}}}
 const v=summarise(gs).verified;for(const a of ['on','off']){const c=o[a];c.local_lease_gpu_kwh=+c.local_lease_gpu_kwh.toFixed(3);c.tokens_per_goal=c.goals?Math.round(c.tokens_total/c.goals):null;c.cloud_tokens_per_goal=c.goals?Math.round(c.tokens_cloud/c.goals):null;
  c.verified=v[a];c.tokens_per_verified=v[a]?Math.round(c.tokens_total/v[a]):null;c.cloud_tokens_per_verified=v[a]?Math.round(c.tokens_cloud/v[a]):null}
 return o}
// registry-equivalent count as of now (string compare, no end)
const regNow=goals.filter(g=>g.nofb&&g.created_at>='2026-10-09T00:00:00.000Z');
const out={generated_at:new Date().toISOString(),horizon:[START,STOP],boundaries:{b947:[B947a,B947b],memory_rules_off:MEM,maker_prompt:PROMPT,brake_weight:'2026-11-07T12:00:09.698Z (after stop_by)',db_rows:d.prepare("SELECT env_name, previous, current, at FROM experiment_period_boundaries WHERE experiment_id='X1' ORDER BY at").all()},
 population:{arm_goals_all_time:{on:goals.filter(g=>g.arm==='on').length,off:goals.filter(g=>g.arm==='off').length},in_horizon_excluding_fallback:base.length,excluded_fallback:excludedFallback,after_stop_by:goals.filter(g=>g.t>=jd(STOP)).length},
 registered_whole_window:summarise(base),
 lanes:{'test-gap':summarise(base.filter(g=>lane(g.refs)==='test-gap')),mutation:summarise(base.filter(g=>lane(g.refs)==='mutation'))},
 periods,
 period_stratified_all:cmh(strat(base)),
 sensitivity_excluding_947:{whole:summarise(no947),period_stratified:cmh(per947.map(([n,s,e])=>{const c=cell(no947.filter(g=>inP(g,s,e)));return{on:c.on,off:c.off}}))},
 period_stratified_lane_x_period:cmh(per.flatMap(([n,s,e])=>['test-gap','mutation'].map(L=>{const c=cell(base.filter(g=>inP(g,s,e)&&lane(g.refs)===L));return{on:c.on,off:c.off}}))),
 siblings:sibStats, sample_evolve_selected:sampleSel,
 cost:{whole:cost(()=>true),excluding_947:cost(g=>!(g.t>=jd(B947a)&&g.t<jd(B947b)))},
 registry_now_equivalent:summarise(regNow)};
console.log(JSON.stringify(out,null,1));
