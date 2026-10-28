import { createRequire } from 'module';
const require = createRequire('/app/packages/server/package.json');
const D = require('better-sqlite3');
const db = new D('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
const out = {};
try {
  const m = await import('/app/packages/server/dist/services/evolution-evidence.js');
  const ee = m.buildEvolutionEvidence(db, process.env, Date.now(), 30);
  out.keys = Object.keys(ee);
  const want = ['at','flags','gates','genomes','trials','graded','learning_ledger','experiments','memory_holdout','ace_001','ste_001','maker_deps_001','checker_family','effort_x1','settlement_execution','merge','fail_before_pass_after','tg_001','intelligence','knowledge_links','ope','hack_rate','gym_prod_gates','attribution','oracle','lineage','provenance','skill_distillation','skill_cards','evolution_feedback','holdout_exposure','value_allocation','unit_economics','gym','outcomes'];
  for (const k of want) if (k in ee) out[k] = ee[k];
} catch (e) { out.ee_err = String(e && e.stack || e).slice(0, 800); }
try { const u = await import('/app/packages/server/dist/services/unit-economics.js'); out.ue = u.unitEconomics(db); } catch (e) { out.ue_err = String(e).slice(0, 300); }
(await import("fs")).writeFileSync("/tmp/evo-ee-out.json", JSON.stringify(out));
process.exit(0);
