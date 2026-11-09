const D=require('better-sqlite3');const d=new D('/data/djimitflo.sqlite',{readonly:true});d.pragma('query_only=1');
const jd=s=>Date.parse(s.includes('T')?s:s.replace(' ','T')+'Z');
const START=jd('2026-10-09T00:00:00Z'),STOP=jd('2026-11-06T00:00:00Z'),A=jd('2026-10-22T00:00:00Z'),B=jd('2026-10-29T17:13:27Z');
const notFb=`NOT EXISTS (SELECT 1 FROM loop_runs fr JOIN worker_leases fl ON fl.loop_run_id = fr.id WHERE fr.goal_id = g.id AND json_extract(fl.metadata, '$.runtime_fallback') IS NOT NULL)`;
const rows=d.prepare(`SELECT g.id gid, g.created_at gc, j.status, j.reason, j.claimed_at, j.finished_at, j.created_at jc FROM worker_leases l JOIN loop_runs r ON r.id=l.loop_run_id JOIN goals g ON g.id=r.goal_id
  LEFT JOIN remote_maker_jobs j ON j.lease_id=l.id WHERE l.role='maker' AND json_extract(l.metadata,'$.evolve_sibling_of') IS NOT NULL AND json_extract(g.metadata,'$.effort_arm')='on' AND ${notFb}`).all()
  .filter(r=>jd(r.gc)>=START&&jd(r.gc)<STOP);
const pw=d.prepare(`SELECT at, gpu_watts w FROM host_power_samples WHERE host='workstation' AND at>=? AND at<=? ORDER BY at`);
function e(st,ct,idle){const r=pw.all(st,ct);let j=0,jx=0;for(let i=1;i<r.length;i++){const dt=(jd(r[i].at)-jd(r[i-1].at))/1000;if(dt>0&&dt<300){const w=(r[i].w+r[i-1].w)/2;j+=dt*w;jx+=dt*Math.max(0,w-idle)}}return [j/3.6e6,jx/3.6e6,r.length]}
const agg=(f)=>{const o={sibling_leases:0,with_job:0,by_job_status:{},reasons:{},claimed_to_finished_h:0,gpu_kwh_gross:0,gpu_kwh_above_40w:0,jobs_with_samples:0};
 for(const r of rows.filter(f)){o.sibling_leases++;if(!r.status){o.by_job_status['no_job']=(o.by_job_status['no_job']||0)+1;continue}o.with_job++;o.by_job_status[r.status]=(o.by_job_status[r.status]||0)+1;
  const rs=(r.reason||'').slice(0,70);if(r.status!=='done'&&r.status!=='completed')o.reasons[rs]=(o.reasons[rs]||0)+1;
  if(r.claimed_at&&r.finished_at){o.claimed_to_finished_h+=(jd(r.finished_at)-jd(r.claimed_at))/3.6e6;const [g,x,n]=e(r.claimed_at,r.finished_at,40);if(n>1){o.gpu_kwh_gross+=g;o.gpu_kwh_above_40w+=x;o.jobs_with_samples++}}}
 for(const k of ['claimed_to_finished_h','gpu_kwh_gross','gpu_kwh_above_40w'])o[k]=+o[k].toFixed(3);return o};
console.log(JSON.stringify({whole:agg(()=>true),pre947:agg(r=>jd(r.gc)<A),w947:agg(r=>jd(r.gc)>=A&&jd(r.gc)<B),post947:agg(r=>jd(r.gc)>=B)},null,1));
