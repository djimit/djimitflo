"""Offline, reproducible audit checks; reads retained metadata, never production."""
import collections
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
def read(name):
    return json.loads((ROOT / name).read_text())

canonical = read('skills-canonical.json')['skills']
by_name = collections.defaultdict(set)
for s in canonical:
    by_name[s['name']].add(s['body_sha256'])
assert len(canonical) == 163
skills = {}
for host in ('macmini', 'eve-v', 'workstation'):
    data = read(f'skills-{host}.json')
    assert all(not c.get('capped') for c in data['coverage'])
    rows = data['skills']
    hashes = collections.Counter(s['body_sha256'] for s in rows)
    matched = [s for s in rows if s['body_sha256'] in by_name.get(s['name'], set())]
    drift = [dict(name=s['name'], root=s['root'], path=s['path'], body_sha256=s['body_sha256'])
             for s in rows if s['name'] in by_name and s['body_sha256'] not in by_name[s['name']]]
    skills[host] = dict(instances=len(rows), unique_bodies=len(hashes),
        duplicate_body_instances=sum(n-1 for n in hashes.values()),
        canonical_name_and_body_matches=len(matched), same_name_different_body=drift,
        outside_canonical_names=sum(s['name'] not in by_name for s in rows),
        meaning='Installation/body identity only; scripts, manifests, invocation and transfer benefit not established by this comparison.')

def fisher(a, b, c, d):
    total = a+b+c+d
    n = a+b
    successes = a+c
    def prob(k):
        return math.comb(successes,k)*math.comb(total-successes,n-k)/math.comb(total,n)
    observed = prob(a)
    return sum(prob(k) for k in range(max(0,n-(total-successes)), min(n,successes)+1)
               if prob(k) <= observed + 1e-14)

assert abs(fisher(1,9,11,3)-0.0027594561852200836) < 1e-12
db = read('runtime-db-evidence.json')
assert not any('error' in q for q in db['results'].values())
assert 'error' not in db['readers']
memory = db['readers']['memory']
r, h = memory['rules'], memory['holdout']
p = fisher(r['verified'], r['regressed'], h['verified'], h['regressed'])
assert round(p,4) == memory['fisher_p']
caps = db['results']['capabilities']['rows']
routes = read('route-api-inventory.json')
assert len(routes['routes']) == 50
eff = read('built-reports.json')['reports']['efficiency']['consumers']
cloud = sum(c['cloud_tokens'] for c in eff)
local_wh = sum(c['wh'] or 0 for c in eff)
out = dict(source_sha=db['source_sha'], skills=skills,
    memory=dict(rules=r, holdout=h, two_sided_fisher_recomputed=p,
                risk_difference=r['verified']/r['n']-h['verified']/h['n'],
                interpretation='Interim descriptive estimate; does not establish benefit or harm; see registered protocol and exclusions.'),
    capabilities=dict(rows=len(caps), statuses=dict(collections.Counter(c['status'] for c in caps)),
                      with_lease_history=sum(c['leases']>0 for c in caps),
                      with_lease_history_7d=sum(c['leases_7d']>0 for c in caps)),
    economics=dict(window_days=7, recorded_cloud_tokens=cloud, metered_local_wh=local_wh,
        gym_share_of_metered_local_wh=next(c['wh'] for c in eff if c['consumer']=='gym:atomic@llama-router')/local_wh,
        missing_cloud_energy_consumers=sum(c['cloud_tokens']>0 and c['wh'] is None for c in eff),
        interpretation='Recorded tokens and metered local energy; excludes unknown cloud energy, prices, host idle power and uninstrumented operations. No ROI claim.'),
    routes=dict(declarations=len(routes['routes']), unique_patterns=len({r['route'] for r in routes['routes']})))
(ROOT/'offline-analysis.json').write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps({**out, 'skills':{k:{a:b for a,b in v.items() if a!='same_name_different_body'} | {'same_name_different_body':len(v['same_name_different_body'])} for k,v in skills.items()}},indent=2))
