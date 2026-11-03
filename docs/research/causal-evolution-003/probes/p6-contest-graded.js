const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const q=(s,...a)=>{try{return d.prepare(s).all(...a)}catch(e){return String(e).slice(0,200)}};
console.log(JSON.stringify(q(`SELECT created_at, metadata FROM loop_events WHERE event_type='contest_graded' ORDER BY created_at`).map(r=>({at:r.created_at,m:JSON.parse(r.metadata||'{}')}))));
