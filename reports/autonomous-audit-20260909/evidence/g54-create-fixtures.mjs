// Synthetic browser/governance fixtures only; explicitly mock makers, no native dispatch.
const base = 'http://127.0.0.1:3187/api';
const auth = await fetch(`${base}/auth/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'audit@example.test',password:process.env.G54_FIXTURE_PASSWORD})}).then(r=>r.json());
const token = auth.token;
if (!token) throw new Error('Fixture login did not return token');
async function call(path, body) {
  const res = await fetch(`${base}${path}`, {method:body ? 'POST':'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:body ? JSON.stringify(body):undefined});
  const data=await res.json(); if(!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`); return data;
}
const fixtures = [];
for (const risk of process.argv.includes('--low-only') ? ['low'] : ['high','low']) {
  const goal = await call('/goals',{objective:`G54 SYNTHETIC ${risk} browser/governance fixture; no provider`,acceptance_criteria:['Exercise UI controls without merging or provider execution'],risk_class:risk});
  const run = await call('/loops/start',{loop_name:'doc-drift-and-small-fix-loop',repository_path:'/private/tmp/djimitflo-g54-browser-p86vLa',goal_id:goal.id,max_findings:1});
  const prepared = await call(`/loops/runs/${run.id}/continue`,{runtime:'mock',max_assignments:1});
  const maker=prepared.leases.find(l=>l.role==='maker');
  const execution=await call(`/loops/runs/${run.id}/execute-maker`,{lease_id:maker.id,timeout_ms:10000});
  if(execution.lease.runtime!=='mock'||execution.lease.status!=='completed')throw new Error('Mock fixture maker not completed');
  const checks=await call(`/loops/runs/${run.id}/run-checks`,{lease_id:maker.id,scripts:['test','lint','type-check']});
  fixtures.push({evidence_class:'synthetic-mock-UI-governance-only',risk,goal_id:goal.id,run_id:run.id,leases:prepared.leases.map(l=>({id:l.id,role:l.role,runtime:l.runtime})),maker:execution.lease,checks:checks.checks});
}
console.log(JSON.stringify({fixtures},null,2));
