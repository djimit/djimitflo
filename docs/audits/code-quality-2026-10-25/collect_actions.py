"""Read-only workflow-run inventory, partitioned daily to avoid the filtered 1000-run cap."""
import datetime as dt
import json
from urllib.parse import urlencode
from collect_github import api,ROOT,REPO,SCOPE

if __name__=='__main__':
    start=dt.datetime.fromisoformat(SCOPE['window_start'].replace('Z','+00:00'))
    end=dt.datetime.fromisoformat(SCOPE['window_end'].replace('Z','+00:00'))
    day=start.replace(hour=0,minute=0,second=0);runs={};windows=[]
    while day<=end:
        date=day.date().isoformat();page=1;seen=0;total=None
        while True:
            data=api(f'repos/{REPO}/actions/runs?'+urlencode(dict(created=date,per_page=100,page=page)))
            total=data['total_count'];batch=data['workflow_runs'];seen+=len(batch)
            for x in batch:
                if not SCOPE['window_start']<=x['created_at']<=SCOPE['window_end']:continue
                row={k:x.get(k) for k in ['id','name','path','event','status','conclusion','head_sha','head_branch','run_attempt','created_at','run_started_at','updated_at','html_url','jobs_url']}
                row['actor']=x.get('actor',{}).get('login')
                row['prs']=[dict(number=p['number'],head_sha=p['head']['sha'],base_sha=p['base']['sha']) for p in x.get('pull_requests',[])]
                runs[x['id']]=row
            if len(batch)<100:break
            page+=1
        assert seen==total,(date,seen,total)
        windows.append(dict(day=date,total=total,received=seen))
        print(f'{date}: {seen} workflow runs; retained {len(runs)}',flush=True)
        day+=dt.timedelta(days=1)
    (ROOT/'workflow-runs.json').write_text(json.dumps(dict(captured_at=dt.datetime.now(dt.timezone.utc).isoformat(),scope=SCOPE,daily_windows=windows,runs=list(runs.values()),limit='Latest attempt per run ID. Prior rerun attempts require attempt-specific retrieval; no execution outcome inferred solely from a green workflow.'),indent=2)+'\n')
    events=[]
    for page in range(1,4):
        rows=api(f'repos/{REPO}/events?per_page=100&page={page}')
        for x in rows:
            p=x.get('payload',{});events.append(dict(id=x['id'],type=x['type'],created_at=x['created_at'],actor=x.get('actor',{}).get('login'),payload={k:p.get(k) for k in ['ref','before','head','size','distinct_size','push_id','action']}))
        if len(rows)<100:break
    (ROOT/'repository-events.json').write_text(json.dumps(dict(captured_at=dt.datetime.now(dt.timezone.utc).isoformat(),events=events,limit='GitHub repository event feed is retention/volume limited; not a complete three-week push audit.'),indent=2)+'\n')
