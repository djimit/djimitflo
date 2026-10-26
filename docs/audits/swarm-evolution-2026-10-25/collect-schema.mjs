import Database from 'better-sqlite3';
const db=new Database('/data/djimitflo.sqlite',{readonly:true,fileMustExist:true});
db.pragma('query_only=ON');db.exec('BEGIN');
const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
const selected=names.filter(n=>/swarm|learning|skill_outcome|power_sample|worker_lease|experiment|genome|memory_candidate|run_memory|runtime_outcome|loop_runs|evaluation|llm_model_call|remote_maker|committee_job/.test(n));
const tables=Object.fromEntries(selected.map(n=>[n,db.prepare('PRAGMA table_info("'+n.replaceAll('"','""')+'")').all().map(c=>({name:c.name,type:c.type}))]));
if(db.pragma('query_only',{simple:true})!==1)throw Error('Not read-only');db.exec('COMMIT');db.close();
console.log(JSON.stringify({at:new Date().toISOString(),source_sha:process.env.DJIMITFLO_COMMIT_SHA,mode:'readonly/query_only schema metadata',tables},null,2));
