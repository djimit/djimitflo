import { createRequire } from 'module';
const require = createRequire('/app/packages/server/package.json');
const D = require('better-sqlite3');
const db = new D('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
const out = { at: new Date().toISOString() };
try {
  const m = await import('/app/packages/server/dist/services/evolution-evidence.js');
  const ee = m.buildEvolutionEvidence(db, process.env, Date.now(), 30);
  for (const k of ['gates','graded','learning_ledger','settlement_execution','merge','lineage','hack_rate','ope','gym_prod_gates','attribution','intelligence','unit_economics']) if (k in ee) out[k] = ee[k];
} catch (e) { out.ee_err = String(e && e.stack || e).slice(0, 600); }
try { const u = await import('/app/packages/server/dist/services/unit-economics.js'); out.ue = u.unitEconomics(db); } catch (e) { out.ue_err = String(e).slice(0, 300); }
console.log(JSON.stringify(out));
process.exit(0);
