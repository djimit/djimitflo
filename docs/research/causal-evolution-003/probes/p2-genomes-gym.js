const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const out={at:new Date().toISOString()};const q=(s,...a)=>{try{return d.prepare(s).all(...a)}catch(e){return String(e).slice(0,200)}};
out.genomes=q(`SELECT id,parent_id,gene,origin,status,created_at,updated_at,substr(note,1,140) note,json_array_length(lines_json) nlines FROM maker_genomes ORDER BY created_at`);
out.trial_cols=q(`pragma table_info(genome_trial_results)`).map?.(c=>c.name);
out.trials=q(`SELECT * FROM genome_trial_results ORDER BY rowid`).map?.(r=>{const o={};for(const[k,v]of Object.entries(r)){o[k]=typeof v==='string'&&v.length>300?v.slice(0,300):v}return o});
// gym attempts: count and wall time by genome (non-null = trial) and overall, 60 d
out.gym_by_genome=q(`SELECT COALESCE(json_extract(metadata,'$.gym.genome'),'(none)') g, COUNT(*) n,
  SUM(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at)-julianday(created_at))*24 ELSE 0 END) h,
  SUM(json_extract(metadata,'$.gym_result.status')='success') ok, SUM(json_extract(metadata,'$.gym_result.status')='failure') fail,
  MIN(created_at) first, MAX(created_at) last FROM loop_runs WHERE loop_name='evolution-gym' GROUP BY 1 ORDER BY n DESC`);
out.gym_total=q(`SELECT COUNT(*) n, SUM(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at)-julianday(created_at))*24 ELSE 0 END) h, MIN(created_at) first FROM loop_runs WHERE loop_name='evolution-gym'`);
out.gym_30d=q(`SELECT COUNT(*) n, SUM(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at)-julianday(created_at))*24 ELSE 0 END) h FROM loop_runs WHERE loop_name='evolution-gym' AND created_at>=datetime('now','-30 days')`);
out.lr_cols=q(`pragma table_info(loop_runs)`).map?.(c=>c.name);
// dream evolution model calls
out.llm_cols=q(`pragma table_info(llm_model_calls)`).map?.(c=>c.name);
out.dream_calls=q(`SELECT purpose, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout, MIN(created_at) first, MAX(created_at) last FROM llm_model_calls WHERE purpose LIKE '%dream%' OR purpose LIKE '%memory%' OR purpose LIKE '%panel%' GROUP BY purpose`);
out.purposes=q(`SELECT purpose, consumer, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout FROM llm_model_calls WHERE created_at>=datetime('now','-30 days') GROUP BY purpose, consumer ORDER BY n DESC LIMIT 40`);
// memory candidates by status & approver kind
out.mem_cols=q(`pragma table_info(memory_candidates)`).map?.(c=>c.name);
out.mem=q(`SELECT status, COUNT(*) n FROM memory_candidates GROUP BY status`);
// skill outcomes per species 30d
out.so=q(`SELECT skill_id, COALESCE(model,'') model, COUNT(*) n, SUM(success) ok FROM skill_outcomes WHERE created_at>=datetime('now','-30 days') AND skill_id LIKE 'loop-maker:%' GROUP BY 1,2 ORDER BY n DESC LIMIT 20`);
console.log(JSON.stringify(out));
