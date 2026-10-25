"""Derive inventories from the retained read-only capture; requires its raw JSON files.

Raw API responses are local working evidence, not part of the published pack.
This script checks collection bounds and derivation, not business correctness.
"""
import collections
import csv
import hashlib
import json
import pathlib
import statistics
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


def table(name, rows):
    with (ROOT / name).open('w', newline='') as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def kind(path):
    if '/__tests__/' in path or '.test.' in path or '.spec.' in path or 'selftest' in path:
        return 'tests'
    if path.startswith(('docs/', 'openwiki/', 'openspec/', 'reports/')):
        return 'documentation_and_evidence'
    if path.startswith('packages/') and '/src/' in path:
        return 'application_source'
    if path.startswith(('scripts/', 'infra/', '.github/')):
        return 'automation_and_infra'
    return 'configuration_and_other'


scope = read('scope.json')
capture = read('pull-requests.json')
prs = capture['prs']
history = read('git-history.json')
commits = history['first_parent_commits']
runs = read('workflow-runs.json')['runs']
checks = {pr['number']: pr for pr in read('check-evidence.json')['prs']}
pr_by_sha = {pr['mergeCommit']['oid']: pr for pr in prs if pr.get('mergeCommit')}
assert capture['cutoff_reached'], 'PR collection did not reach the window boundary'
assert len({p['number'] for p in prs}) == len(prs)
assert len({r['id'] for r in runs}) == len(runs)
assert all(scope['window_start'] <= r['created_at'] <= scope['window_end'] for r in runs)
assert all(c['sha'] in pr_by_sha for c in commits), 'unmapped mainline commit'
assert all(len(p['files']['nodes']) == p['changedFiles'] for p in prs)
assert all(not p['reviews']['pageInfo']['hasPreviousPage'] for p in prs)
assert all(not p['reviewThreads']['pageInfo']['hasNextPage'] for p in prs)
assert all(not p['commits']['nodes'][0]['commit']['statusCheckRollup']['contexts']['pageInfo']['hasNextPage']
           for p in checks.values() if p['commits']['nodes'] and p['commits']['nodes'][0]['commit'].get('statusCheckRollup'))

pr_rows = []
for p in prs:
    check = checks[p['number']]['commits']['nodes']
    head = check[0]['commit'] if check else None
    rollup = head.get('statusCheckRollup') if head else None
    threads = p['reviewThreads']['nodes']
    pr_rows.append(dict(number=p['number'], url=p['url'], title=p['title'], state=p['state'],
                        draft=p['isDraft'], created_at=p['createdAt'], updated_at=p['updatedAt'],
                        merged_at=p['mergedAt'], head_sha=p['headRefOid'],
                        merge_sha=(p.get('mergeCommit') or {}).get('oid'), files=p['changedFiles'],
                        additions=p['additions'], deletions=p['deletions'],
                        review_submissions=len(p['reviews']['nodes']),
                        unresolved_current_threads=sum(not t['isResolved'] and not t['isOutdated'] for t in threads),
                        observed_check_sha=head['oid'] if head else None,
                        observed_check_state=rollup['state'] if rollup else 'UNKNOWN',
                        observed_check_matches_pr_head=bool(head and head['oid'] == p['headRefOid'])))
table('pull-request-inventory.csv', pr_rows)
table('commit-inventory.csv', [dict(sha=c['sha'], pr=pr_by_sha[c['sha']]['number'],
                                  committed_at=c['committed_date'], subject=c['subject'],
                                  changed_files=len(c['files'])) for c in commits])
paths = collections.defaultdict(lambda: dict(touches=0, additions=0, deletions=0))
for c in commits:
    for f in c['files']:
        row = paths[f['path']]
        row['touches'] += 1
        row['additions'] += f['additions'] or 0
        row['deletions'] += f['deletions'] or 0
table('changed-path-inventory.csv', [dict(path=p, category=kind(p), **r)
                                    for p, r in sorted(paths.items(), key=lambda item: (-item[1]['touches'], item[0]))])
table('failed-main-ci.csv', [dict(run_id=r['id'], url=r['html_url'], sha=r['head_sha'],
                                pr=pr_by_sha.get(r['head_sha'], {}).get('number'),
                                created_at=r['created_at'], latest_attempt=r['run_attempt'])
                           for r in runs if r['name'] == 'CI' and r['event'] == 'push'
                           and r['head_branch'] == 'main' and r['conclusion'] == 'failure'])
merged = [p for p in prs if p['mergedAt'] and scope['window_start'] <= p['mergedAt'] <= scope['window_end']]
threads = [t for p in prs for t in p['reviewThreads']['nodes']]
reviews = [r for p in prs for r in p['reviews']['nodes']]
ci = [r for r in runs if r['name'] == 'CI']
required = set(read('main-protection.json')['required_status_checks']['contexts'])
green_before_merge = 0
for pr in merged:
    head = checks[pr['number']]['commits']['nodes'][0]['commit']
    contexts = head['statusCheckRollup']['contexts']['nodes']
    green = {c.get('name') for c in contexts if c.get('conclusion') == 'SUCCESS'
             and c.get('completedAt') and c['completedAt'] <= pr['mergedAt']}
    green_before_merge += required <= green
main_ci_shas = {r['head_sha'] for r in ci if r['event'] == 'push' and r['head_branch'] == 'main'}
stats = dict(scope=scope, mainline_commits=len(commits), reachable_commits=len(history['all_reachable_window_commits']),
             changed_paths=len(paths), path_touches=sum(v['touches'] for v in paths.values()),
             pr_states=dict(collections.Counter(p['state'] for p in prs)), merged_in_window=len(merged),
             open_drafts=sum(p['state'] == 'OPEN' and p['isDraft'] for p in prs),
             median_merge_hours=statistics.median((time(p['mergedAt']) - time(p['createdAt'])).total_seconds() / 3600 for p in merged),
             median_merged_diff_lines=statistics.median(p['additions'] + p['deletions'] for p in merged),
             median_merged_files=statistics.median(p['changedFiles'] for p in merged),
             review_states=dict(collections.Counter(r['state'] for r in reviews)),
             review_threads=len(threads), unresolved_threads=sum(not t['isResolved'] for t in threads),
             unresolved_not_outdated_threads=sum(not t['isResolved'] and not t['isOutdated'] for t in threads),
             workflows=len(runs), workflow_conclusions=dict(collections.Counter(r['conclusion'] or 'in_progress' for r in runs)),
             ci_main_conclusions=dict(collections.Counter(r['conclusion'] or 'in_progress' for r in ci if r['event'] == 'push' and r['head_branch'] == 'main')),
             ci_pr_conclusions=dict(collections.Counter(r['conclusion'] or 'in_progress' for r in ci if r['event'] == 'pull_request')),
             changed_path_categories=dict(collections.Counter(kind(p) for p in paths)),
             captured_heads_with_current_required_success_before_merge=green_before_merge,
             main_commits_without_indexed_main_push_ci=[c['sha'] for c in commits if c['sha'] not in main_ci_shas],
             checks_head_mismatches=[r['number'] for r in pr_rows if not r['observed_check_matches_pr_head']])
(ROOT / 'statistics.json').write_text(json.dumps(stats, indent=2) + '\n')
raw = ['scope.json', 'pull-requests.json', 'git-history.json', 'review-evidence.json', 'check-evidence.json',
       'workflow-runs.json', 'repository-events.json', 'failed-ci-jobs.json', 'main-protection.json', 'repository.json', 'rulesets.json']
(ROOT / 'raw-evidence-manifest.json').write_text(json.dumps(dict(
    availability='Local working evidence; not distributed. Hashes identify this capture, not a public validation PASS.',
    files=[dict(name=n, bytes=(ROOT/n).stat().st_size, sha256=hashlib.sha256((ROOT/n).read_bytes()).hexdigest()) for n in raw]), indent=2) + '\n')
print(json.dumps(stats, indent=2))
