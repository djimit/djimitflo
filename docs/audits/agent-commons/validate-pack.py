"""Offline evidence/link/claim checks; does not contact or change production."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHA = 'bf6f647c49b70a65ab795b113f512b9c84ca08a1'
names = ['README.md', 'engineering-backlog.md', 'operating-model.md', 'evidence-and-validation.md', 'source-evidence-index.md']
for name in names:
    assert (ROOT / name).is_file(), name
    assert len((ROOT / name).read_text().split()) > 150, name
evidence = json.loads((ROOT / 'runtime-evidence.json').read_text())
diagnostics = json.loads((ROOT / 'diagnostics.json').read_text())
analysis = json.loads((ROOT / 'analysis.json').read_text())
identity = json.loads((ROOT / 'live-identity.json').read_text())
assert identity['commit'] == identity['build']['built_commit'] == SHA
assert identity['build']['commit_matches_build'] is True
for d in [evidence, diagnostics]:
    assert d['source_sha'] == SHA
    assert all('error' not in q for q in d['results'].values())
assert 'error' not in evidence['readers']
assert analysis['panel_review']['affected_panels'] == 10
assert analysis['yield_contract']['goal_links'] == 0
assert analysis['conversations']['latest_page_record_only_share'] == .84
for name in ['collect-evidence.mjs', 'collect-diagnostics.mjs']:
    code = (ROOT / name).read_text()
    assert 'readonly:true' in code.replace(' ', '')
    assert 'query_only=ON' in code
assert '49 passed (49)' in (ROOT / 'source-pinned-tests.log').read_text()
assert '11 passed (11)' in (ROOT / 'review-contract-tests.log').read_text()
assert '4 passed (4)' in (ROOT / 'offline-replay.log').read_text()
links = 0
for path in ROOT.glob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if target.startswith(('http://', 'https://', '#')):
            continue
        target = target.split('#')[0]
        assert target == 'validation.json' or (path.parent / target).exists(), (path.name, target)
        links += 1
secret = re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|nvapi-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')
for path in ROOT.iterdir():
    if path.suffix in {'.md', '.json', '.mjs', '.py', '.log', '.ts'}:
        assert not secret.search(path.read_text()), f'Potential credential pattern in {path.name}; inspect locally without disclosure'
out = dict(status='PASS', source_sha=SHA, source_identity='live build matches retained evidence',
    read_queries=len(evidence['results'])+len(diagnostics['results']),
    existing_focused_tests=60, audit_replay_tests=4, local_links=links,
    application_changes=0, production_mutations=0,
    limits='Offline consistency and focused fixture checks; not full CI, native repair, independent efficacy or causal benefit proof.')
(ROOT / 'validation.json').write_text(json.dumps(out, indent=2)+'\n')
files = sorted(p for p in ROOT.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
(ROOT / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
print(json.dumps(out, indent=2))
