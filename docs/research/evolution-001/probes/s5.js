const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const rows=d.prepare("select created_at, json_extract(metadata,'$.gym_result') gr from loop_runs where loop_name='evolution-gym' and json_extract(metadata,'$.gym.genome')='baseline' and created_at>='2026-10-16' order by created_at").all();
const out=rows.map(r=>{let g={};try{g=JSON.parse(r.gr||'{}')}catch{};return {at:r.created_at.slice(0,16),keys:Object.keys(g).join(','),model:g.model||g.router_model||g.served_model||null,worker:g.worker_sha256||g.worker||g.worker_version||null,graded:g.graded??null,steps:g.max_steps??null}});
console.log(JSON.stringify(out));
