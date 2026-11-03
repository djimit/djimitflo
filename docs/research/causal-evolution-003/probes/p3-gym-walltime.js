const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const q=(s,...a)=>{try{return d.prepare(s).all(...a)}catch(e){return String(e).slice(0,200)}};const out={};
out.gym_time=q(`SELECT CASE WHEN json_extract(metadata,'$.gym.genome') IS NULL THEN 'non-trial' ELSE 'trial' END k, COUNT(*) n,
 SUM((julianday(updated_at)-julianday(created_at))*24) h, AVG((julianday(updated_at)-julianday(created_at))*60) avg_min FROM loop_runs WHERE loop_name='evolution-gym' AND status<>'running' GROUP BY 1`);
out.gym_trial_epoch0_window=q(`SELECT COUNT(*) n, SUM((julianday(updated_at)-julianday(created_at))*24) h FROM loop_runs WHERE loop_name='evolution-gym' AND json_extract(metadata,'$.gym.genome') IS NOT NULL AND created_at<'2026-10-16'`);
out.gym_trial_since16=q(`SELECT COUNT(*) n, SUM((julianday(updated_at)-julianday(created_at))*24) h FROM loop_runs WHERE loop_name='evolution-gym' AND json_extract(metadata,'$.gym.genome') IS NOT NULL AND created_at>='2026-10-16'`);
out.makers30=q(`SELECT runtime, status, COUNT(*) n, SUM((julianday(updated_at)-julianday(created_at))*24) h FROM worker_leases WHERE role='maker' AND created_at>=datetime('now','-30 days') GROUP BY 1,2`);
out.power=q(`pragma table_info(host_power_samples)`).map?.(c=>c.name);
console.log(JSON.stringify(out));
