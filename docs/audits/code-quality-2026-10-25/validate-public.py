"""Check only the distributed audit subset; does not certify withheld evidence."""
import csv
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[2]
stats = json.loads((root / 'statistics.json').read_text())
rows = lambda name: list(csv.DictReader((root / name).open()))
prs = rows('pull-request-inventory.csv')
commits = rows('commit-inventory.csv')
paths = rows('changed-path-inventory.csv')
assert len(prs) == sum(stats['pr_states'].values()) == 417
assert len({p['number'] for p in prs}) == len(prs)
assert len(commits) == stats['mainline_commits'] == 329
assert len(paths) == stats['changed_paths'] == 1041
assert sum(int(p['touches']) for p in paths) == stats['path_touches']
assert all(c['pr'] in {p['number'] for p in prs} for c in commits)
assert len(rows('failed-main-ci.csv')) == stats['ci_main_conclusions']['failure'] == 8
verification = json.loads((root / 'verification.json').read_text())
assert all(c['exit_code'] == 0 for c in verification['checks'])
for entry in verification['code_content']:
    assert hashlib.sha256((repo / entry['path']).read_bytes()).hexdigest() == entry['sha256'], entry['path']
assert (root / 'verification-evidence.txt').is_file()
assert (root / 'audit-pack-inspection.json').is_file()
print('Distributed inventories and code-content binding: PASS')
print('Raw API capture, withheld full logs, production and historical merge-time approvals: NOT independently validated')
