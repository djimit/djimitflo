const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const t=["maker_genomes","genome_trial_results","gym_holdout","gym_mutant_holdout","gym_write_test_holdout","gym_holdout_freezes","skill_cards","memory_candidates","memory_access_log","skill_outcomes","outcome_credits","skill_genomes","dream_state_ledger","outcome_learning_assessments","judgments","worker_leases","loop_runs","remote_maker_jobs","experiments","tg_experiments","tg_attempts","settlement_execution","merge_outcomes","kb_pages","policy_violations","evolution_estimates","host_power_samples","llm_model_calls","gym_attempt_diffs","commons_threads","social_messages"];
const out={};const all=d.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name);
out.tables_present=t.filter(x=>all.includes(x));out.tables_missing=t.filter(x=>!all.includes(x));
out.like=all.filter(n=>/genome|dream|skill|memory|holdout|trial|credit|settle|commons|lesson|learning|experiment/.test(n));
for(const x of out.tables_present){try{out[x]={cols:d.prepare(`pragma table_info(${x})`).all().map(c=>c.name),n:d.prepare(`select count(*) n from ${x}`).get().n}}catch(e){out[x]=String(e)}}
console.log(JSON.stringify(out));
