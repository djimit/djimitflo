"""Read-only step-level evidence for every failed CI run in the retained window."""
import concurrent.futures,datetime,json
from collect_github import ROOT,api,REPO

def collect(run):
    data=api(f'repos/{REPO}/actions/runs/{run["id"]}/jobs?filter=latest&per_page=100')
    assert len(data['jobs'])==data['total_count'],run['id']
    return dict(run_id=run['id'],sha=run['head_sha'],event=run['event'],created_at=run['created_at'],attempt=run['run_attempt'],jobs=[{**{k:j.get(k) for k in ['id','name','status','conclusion','started_at','completed_at','html_url']},'steps':[{k:s.get(k) for k in ['number','name','status','conclusion','started_at','completed_at']} for s in j.get('steps',[])]} for j in data['jobs']])

if __name__=='__main__':
    runs=[r for r in json.loads((ROOT/'workflow-runs.json').read_text())['runs'] if r['path']=='.github/workflows/ci.yml' and r['conclusion']=='failure']
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:rows=list(pool.map(collect,runs))
    (ROOT/'failed-ci-jobs.json').write_text(json.dumps(dict(captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),runs=rows,limit='Latest run attempt, step state only; no raw secret-bearing logs retained.'),indent=2)+'\n')
    print(f'Captured job/step metadata for all {len(rows)} failed CI runs.')
