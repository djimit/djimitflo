const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const t=d.prepare("select json_extract(task_json,'$.tier') tier, count(*) n, count(distinct json_extract(task_json,'$.file')) files from gym_mutant_holdout where epoch=1 group by 1").all();
const wt=d.prepare("select key, created_at from gym_write_test_holdout where epoch=1").all();
const wtr=d.prepare("select created_at, json_extract(metadata,'$.gym.kind') k, json_extract(metadata,'$.gym.genome') g, json_extract(metadata,'$.gym_result.status') st, json_extract(metadata,'$.gym_result.graded') gr from loop_runs where loop_name='evolution-gym' and json_extract(metadata,'$.gym.kind')='write_test' and created_at>='2026-10-14' order by created_at").all();
const perday=d.prepare("select substr(created_at,1,13) h, count(*) n from loop_runs where loop_name='evolution-gym' and created_at>='2026-10-22 11:00' group by 1").all();
console.log(JSON.stringify({t,wt:wt.length,wtr,perday}));
