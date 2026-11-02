"""Read-only current PR-head check rollups. These are not reconstructed merge-time check states."""
import datetime,json
from collect_github import ROOT,graph

if __name__=='__main__':
    numbers=[p['number'] for p in json.loads((ROOT/'pull-requests.json').read_text())['prs']];out=[]
    for offset in range(0,len(numbers),15):
        fields=''.join('p'+str(n)+':pullRequest(number:'+str(n)+'''){number headRefOid commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){totalCount pageInfo{hasNextPage} nodes{
... on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{databaseId}}}
... on StatusContext{context state createdAt targetUrl}
}}}}}}}''' for n in numbers[offset:offset+15])
        data=graph('query{repository(owner:"djimit",name:"djimitflo"){'+fields+'}}',{})['repository'];out.extend(data.values())
    (ROOT/'check-evidence.json').write_text(json.dumps(dict(captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),prs=out,limit='Current latest PR-head rollup, up to 100 contexts with explicit truncation. Completed-after-merge checks do not certify pre-merge state.'),indent=2)+'\n')
    print(f'Captured current check rollups for {len(out)} PRs')
