// Production inspection only: readonly connection, query_only, schema and counts; no row content.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const db = new Database('/data/djimitflo.sqlite', {readonly:true,fileMustExist:true});
db.pragma('query_only=ON');
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
assert(tables.includes('worker_leases') && tables.includes('self_improvements'));
const selected=tables.filter(n=>/skill|memor|knowledge|expert|experiment|trial|genome|gym|swarm|worker|lease|model|agent|trace|event|rout|registry|tg_|ace_|ste_|effort|checker|tuning|judgment|loop_run|goal|outcome|retrieval|pr_settlements/.test(n));
const result=selected.map(name=>{
  assert(/^[a-zA-Z0-9_]+$/.test(name));
  return {name,n:db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n,columns:db.prepare(`PRAGMA table_info("${name}")`).all().map(c=>({name:c.name,type:c.type,pk:c.pk})),foreign_keys:db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map(k=>({table:k.table,from:k.from,to:k.to}))};
});
assert.equal(db.pragma('query_only',{simple:true}),1);
console.log(JSON.stringify({captured_at:new Date().toISOString(),mode:'readonly + query_only',all_tables:tables,selected:result},null,2));
db.close();
