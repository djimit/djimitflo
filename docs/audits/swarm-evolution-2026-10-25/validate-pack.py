"""Offline evidence/link/source checks and derived counts; no production or application writes."""
from pathlib import Path
from collections import Counter
import hashlib
import json
import re
import subprocess

root=Path(__file__).resolve().parent
source=Path('/private/tmp/djimitflo-swarm-audit-src')
sha='e8d0de33bbae8736d7ab0b4f9195292a2e9f56aa'
read=lambda name:json.loads((root/name).read_text())
r,l=read('runtime-evidence.json'),read('learning-evidence.json')
for data in [r,l,read('schema-evidence.json')]:assert data['source_sha']==sha
for name in ['live-identity.json','live-identity-final.json']:
    d=read(name);assert d['commit']==d['build']['built_commit']==sha
    assert d['build']['commit_matches_build'] is True
for d in [r,l]:
    assert all('error' not in q for q in d['results'].values())
    assert all(not(isinstance(v,dict) and 'error' in v) for v in d['readers'].values())
assert 'comparison_error' not in l['readers']
for name in ['collect-schema.mjs','collect-runtime.mjs','collect-learning.mjs']:
    code=(root/name).read_text();assert 'readonly:true' in code and 'query_only=ON' in code
assert r['results']['agent_counters']['rows']==[dict(status='active',n=32,total_tasks=15819,completed_tasks=15336,failed_tasks=483,tokens=0,execution_ms=0)]
closures=r['results']['closure_records']['rows'][0]
assert (closures['n'],closures['positive_delta'],closures['negative_delta'])==(131,24,22)
lane=next(x for x in r['results']['closure_coverage']['rows'] if x['loop_name']=='doc-drift-and-small-fix-loop' and x['status']=='completed')
assert (lane['runs7d'],lane['closures7d'])==(41,29)
assert len(l['results']['unclosed_repair_runs']['rows'])==12
assert all(not(x['withheld'] and x['rules']) for x in l['results']['memory_arm_consistency']['rows'])
cohorts={x['kind']:x['n'] for x in r['results']['skill_identity_7d']['rows']}
assert cohorts==dict(production_maker=69,gym=173,merge_survival=23,agent_reported=40)
eff=r['readers']['efficiency'];assert eff['coverage']['window_pct']>=99
host=eff['hosts'][0];assert host['host']=='workstation' and host['gpu_kwh']>0
by={c['consumer']:c for c in eff['consumers']}
gym=by['gym:atomic@llama-router']['wh'];maker=by['maker:remote@workstation/atomic@llama-router']['wh']
attributed=sum(c['wh'] or 0 for c in eff['consumers'])
assert attributed<=host['gpu_kwh']*1000
exp=l['readers']['experiments'];memory=next(x for x in exp['experiments'] if x['id']=='memory-holdout')
assert memory['overdue'] is True and memory['n_per_arm']==dict(rules=73,holdout=35)
assert exp['wip']['guard_ok'] is True and exp['wip']['active_count']==6
assert '75 passed | 2 skipped (77)' in (root/'focused-tests-initial.log').read_text()
assert '10 passed (10)' in (root/'resource-ledger-tests.log').read_text()
assert '1 passed (1)' in (root/'metric-replay.log').read_text()
assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()==sha
subprocess.run(['git','-C',str(source),'diff','--exit-code'],check=True,capture_output=True)
anchors=read('source-anchors.json');assert anchors['source_sha']==sha
for a in anchors['anchors']:assert a['needle'] in (source/a['file']).read_text().splitlines()[a['line']-1]
links=0
for f in root.glob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)',f.read_text()):
        if target.startswith(('https://','http://','#')):continue
        assert target=='validation.json' or (f.parent/target.split('#')[0]).exists(),(f.name,target)
        links+=1
secret=re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|nvapi-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')
for f in root.iterdir():
    if f.suffix in {'.md','.json','.mjs','.mts','.py','.log','.ts','.txt'}:
        assert not secret.search(f.read_text()),f'Inspect potential secret in {f.name} locally without disclosure'
out=dict(status='PASS',source_sha=sha,read_queries=len(r['results'])+len(l['results']),
    existing_tests_passed=85,existing_tests_skipped=2,audit_http_reproductions_passed=1,
    source_anchors=len(anchors['anchors']),local_links=links,application_changes=0,production_mutations=0,
    recorded_tokens_7d=dict(cloud=sum(c['cloud_tokens'] for c in eff['consumers']),local=sum(c['local_tokens'] for c in eff['consumers']),complete_ecosystem_coverage=False),
    gpu_7d=dict(host=host['host'],kwh=host['gpu_kwh'],coverage_pct=eff['coverage']['window_pct'],gym_wh=gym,remote_maker_wh=maker,gym_to_maker_ratio=round(gym/maker,2),unattributed_wh=round(host['gpu_kwh']*1000-attributed,3),whole_host_or_cloud_energy=False),
    latest100_run_mix=dict(Counter(x['loop_name'] for x in r['results']['recent_curve_cohort']['rows'])),
    completed_repair_runs_7d=41,closures_for_these_runs=29,missing_closure_eligibility_not_proven=12,
    memory_holdout_readout_due=True,
    limits='Snapshot/source/isolated tests, not full CI, independent meter calibration, a new native trial, causal improvement or universal swarm coverage.')
(root/'validation.json').write_text(json.dumps(out,indent=2)+'\n')
files=sorted(p for p in root.iterdir() if p.is_file() and p.name!='SHA256SUMS')
(root/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
print(json.dumps(out,indent=2))
