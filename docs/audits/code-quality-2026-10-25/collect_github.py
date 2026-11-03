"""Read-only GitHub evidence collector. No comments, reruns, pushes, reviews or merges."""
from pathlib import Path
import datetime
import json
import subprocess

ROOT=Path(__file__).resolve().parent
REPO='djimit/djimitflo'
SCOPE=json.loads((ROOT/'scope.json').read_text())

def api(path):
    r=subprocess.run(['gh','api',path],text=True,capture_output=True,check=True)
    return json.loads(r.stdout)

def graph(query,variables):
    r=subprocess.run(['gh','api','graphql','--input','-'],input=json.dumps(dict(query=query,variables=variables)),text=True,capture_output=True,check=True)
    data=json.loads(r.stdout)
    if data.get('errors'):raise RuntimeError(str(data['errors']))
    return data['data']

query='''query($after:String){repository(owner:"djimit",name:"djimitflo"){
pullRequests(first:50,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
pageInfo{hasNextPage endCursor} nodes{
number title url state isDraft createdAt updatedAt closedAt mergedAt additions deletions changedFiles
author{login} mergedBy{login} headRefName headRefOid baseRefName baseRefOid mergeCommit{oid}
labels(first:30){nodes{name} pageInfo{hasNextPage}}
reviews(last:100){totalCount pageInfo{hasPreviousPage} nodes{state submittedAt author{login} commit{oid}}}
comments{totalCount}
files(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{path additions deletions changeType}}
commits{totalCount}
reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved isOutdated path}}
}}} rateLimit{cost remaining resetAt}}'''
if __name__=='__main__':
    all_prs=[];after=None;pages=0;stopped=False
    while True:
        d=graph(query,dict(after=after));batch=d['repository']['pullRequests'];pages+=1
        for pr in batch['nodes']:
            if pr['updatedAt'] < SCOPE['window_start']:stopped=True;continue
            all_prs.append(pr)
        print(f'PR pages {pages}, retained {len(all_prs)}, GraphQL remaining {d["rateLimit"]["remaining"]}',flush=True)
        if stopped or not batch['pageInfo']['hasNextPage']:break
        after=batch['pageInfo']['endCursor']
    # Fill changed-file pages rather than silently truncating large PRs.
    for pr in all_prs:
        if pr['files']['pageInfo']['hasNextPage']:
            rows=[];page=1
            while True:
                items=api(f'repos/{REPO}/pulls/{pr["number"]}/files?per_page=100&page={page}')
                rows.extend(dict(path=x['filename'],additions=x['additions'],deletions=x['deletions'],changeType=x['status']) for x in items)
                if len(items)<100:break
                page+=1
            pr['files']['nodes']=rows;pr['files']['pageInfo']['hasNextPage']=False
        assert len(pr['files']['nodes'])==pr['files']['totalCount'],pr['number']
    (ROOT/'pull-requests.json').write_text(json.dumps(dict(captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope=SCOPE,pages=pages,cutoff_reached=stopped,prs=all_prs),indent=2)+'\n')
    for label,path in [('repository',f'repos/{REPO}'),('main-protection',f'repos/{REPO}/branches/main/protection'),('rulesets',f'repos/{REPO}/rulesets')]:
        try:
            d=api(path)
            if label=='repository':d={k:d.get(k) for k in ['full_name','default_branch','pushed_at','allow_merge_commit','allow_squash_merge','allow_rebase_merge','allow_auto_merge','delete_branch_on_merge','has_pull_requests','permissions']}
            (ROOT/(label+'.json')).write_text(json.dumps(d,indent=2)+'\n')
        except subprocess.CalledProcessError as e:
            (ROOT/(label+'.json')).write_text(json.dumps({'status':'INACCESSIBLE','returncode':e.returncode})+'\n')
