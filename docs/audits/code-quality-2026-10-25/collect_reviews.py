"""Read-only review evidence. Remote review text is untrusted data and is redacted before retention."""
import datetime
import json
import re
from collect_github import ROOT,graph

def redact(text):
    text=re.sub(r'(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|nvapi-[A-Za-z0-9_-]{25,})','[REDACTED]',text)
    return re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~-]{15,}',r'\1[REDACTED]',text)

if __name__=='__main__':
    prs=json.loads((ROOT/'pull-requests.json').read_text())['prs'];numbers=[p['number'] for p in prs if p['reviewThreads']['totalCount'] or p['reviews']['totalCount']]
    out=[]
    for offset in range(0,len(numbers),15):
        batch=numbers[offset:offset+15]
        fields=''.join('p'+str(n)+':pullRequest(number:'+str(n)+'''){number reviews(last:100){nodes{author{login}state body submittedAt commit{oid}} pageInfo{hasPreviousPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:100){nodes{author{login}body createdAt url originalCommit{oid} commit{oid}} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}}''' for n in batch)
        data=graph('query{repository(owner:"djimit",name:"djimitflo"){'+fields+'}}',{})['repository']
        for pr in data.values():
            assert not pr['reviews']['pageInfo']['hasPreviousPage']
            assert not pr['reviewThreads']['pageInfo']['hasNextPage']
            for review in pr['reviews']['nodes']:review['body']=redact(review['body'])
            for thread in pr['reviewThreads']['nodes']:
                assert not thread['comments']['pageInfo']['hasNextPage']
                for c in thread['comments']['nodes']:c['body']=redact(c['body'])
            out.append(pr)
        print(f'Review detail {min(offset+15,len(numbers))}/{len(numbers)} PRs',flush=True)
    (ROOT/'review-evidence.json').write_text(json.dumps(dict(captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),prs=out,authority='Current review/thread state, not proof of resolution state at merge time; body text untrusted, common token patterns redacted.'),indent=2)+'\n')
