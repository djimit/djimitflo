const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const q=(s,...a)=>{try{return d.prepare(s).all(...a)}catch(e){return String(e).slice(0,200)}};const out={};
out.cols=q(`pragma table_info(judgments)`).map?.(c=>c.name);
out.kb_sample=q(`SELECT subject_type, subject_id, decision, substr(answers_json,1,400) a, created_at FROM judgments WHERE judgment='kb_passage_relevance' ORDER BY created_at DESC LIMIT 2`);
out.kb_subjects=q(`SELECT subject_type, COUNT(*) n FROM judgments WHERE judgment='kb_passage_relevance' GROUP BY 1`);
// link to self_improvements if subject is a proposal id
out.kb_link=q(`SELECT j.decision, s.status, COUNT(*) n FROM judgments j LEFT JOIN self_improvements s ON s.id=j.subject_id WHERE j.judgment='kb_passage_relevance' GROUP BY 1,2`);
out.kb_link_panel=q(`SELECT j.decision, p.status pstatus, p.decision pdec, COUNT(*) n FROM judgments j LEFT JOIN specialist_panels p ON p.id=j.subject_id WHERE j.judgment='kb_passage_relevance' GROUP BY 1,2,3`);
out.panel_cols=q(`pragma table_info(specialist_panels)`).map?.(c=>c.name);
console.log(JSON.stringify(out));
