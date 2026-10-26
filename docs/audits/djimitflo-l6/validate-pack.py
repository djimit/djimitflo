"""Validate audit completeness, retained evidence shapes and local references offline."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHA = 'f957b552c9f02ffc5fb25c45d24431610e57f278'
docs = sorted(ROOT.glob('[0-9][0-9]-*.md'))
assert [int(p.name[:2]) for p in docs] == list(range(1, 21))
assert all(len(p.read_text().split()) >= 250 for p in docs)
parsed = {}
for path in ROOT.glob('*.json'):
    parsed[path.name] = json.loads(path.read_text())
for path in ROOT.glob('*.jsonl'):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    assert rows, path.name
    if path.name == 'postgres-evidence.jsonl':
        assert len(rows) == 13 and rows[0]['read_only'] == 'on'

db = parsed['runtime-db-evidence.json']
assert db['source_sha'] == SHA
assert len(db['results']) == 38 and len(db['readers']) == 6
assert not any('error' in q for q in db['results'].values())
assert 'error' not in db['readers']
assert parsed['live-identity.json']['health']['commit'] == SHA
routes = parsed['route-api-inventory.json']
assert routes['source_sha'] == SHA
assert len(routes['routes']) == 50
assert len({r['route'] for r in routes['routes']}) == 49
assert len(routes['publicRoutes']) == 7
assert all(r['route_file'].endswith('/App.tsx') and r['route_line'] > 0 for r in routes['routes'])
assert parsed['qdrant-collections.json']['http'] == 200
assert len(parsed['qdrant-collections.json']['collections']) == 24
assert len(list(ROOT.glob('[0-9][0-9]-*.png'))) == 5

links = 0
for path in ROOT.glob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if target.startswith(('https://', 'http://', '#')):
            continue
        target = target.split('#')[0]
        assert target == 'validation.json' or (path.parent / target).exists(), (path.name, target)
        links += 1

# Detect likely credential values without ever printing matched text.
secrets = re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|nvapi-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')
for path in ROOT.iterdir():
    if path.is_file() and path.suffix in {'.md', '.json', '.jsonl', '.txt', '.mjs', '.py', '.sql', '.sh'}:
        assert not secrets.search(path.read_text()), f'Potential credential pattern in {path.name}; inspect locally without disclosure'

result = dict(status='PASS', deliverables=20, source_sha=SHA,
    sqlite_queries=38, existing_readers=6, json_files=len(parsed),
    local_markdown_links=links, fresh_screenshots=5,
    credential_pattern_check='no known credential-value patterns found; not an exhaustive secret/PII guarantee',
    limits='Offline artifact checks, not application regression/CI or independent outcome replication.')
(ROOT / 'validation.json').write_text(json.dumps(result, indent=2) + '\n')
files = sorted(p for p in ROOT.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
(ROOT / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
print(json.dumps(result, indent=2))
