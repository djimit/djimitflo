"""Offline retained-evidence checks. No production access or application changes."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parent
sha = '936b93479920d5c251cf006bc42771c9142fa136'
read = lambda name: json.loads((root / name).read_text())
runtime, diagnostics = read('runtime-evidence.json'), read('diagnostics.json')
policy, native, source = read('policy-and-identity.json'), read('native-runtime.json'), read('source-and-checks.json')
for evidence in [runtime, diagnostics, policy]:
    assert evidence['source_sha'] == sha
for evidence in [runtime, diagnostics]:
    assert all('error' not in q for q in evidence['results'].values())
assert 'error' not in runtime['readers']
assert policy['health']['commit'] == policy['health']['build']['built_commit'] == sha
assert policy['health']['build']['commit_matches_build'] is True
assert policy['flags']['REFLECTION_PROPOSALS_MAX_PER_DAY'] == '0'
assert policy['reflection_proposals_24h']['rows'][0]['n'] == 0
assert native['script']['sha256'] == source['repository_poller']['sha256']
assert native['script']['accepts_hermes_source_tool_default'] is True
assert native['service']['Result'] == 'success' and native['service']['ExecMainStatus'] == '0'
assert native['timer_recheck']['ActiveState'] == 'active'
assert source['changed_files'] == ['scripts/agent-social-poller.py', 'scripts/test_agent_social_poller.py']
assert source['existing_test_run']['tests'] == 13 and source['existing_test_run']['exit_code'] == 0
assert '3 passed (3)' in (root / 'policy-replay.log').read_text()
usage = {row['from_agent']: row for row in diagnostics['results']['external_usage_7d']['rows']}
assert usage['hermes-eve-v']['n'] == 16 and usage['hermes-eve-v']['reported_total_tokens'] is None
assert usage['deerflow']['reported_total_tokens'] == 272802
lessons = next(r for r in runtime['results']['last_7d']['rows'] if r['kind'] == 'discussion' and r['action'] == 'social.learning')
assert lessons['threads'] == 8
interest = diagnostics['results']['interests_without_grounding_7d']['rows'][0]
assert (interest['n'], interest['proposed_improvement'], interest['outside_conversation_evidence']) == (39, 31, 0)
assert interest['registered_improvement'] is None
assert runtime['readers']['stops']['goal'] == 0
links = 0
for file in root.glob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)', file.read_text()):
        if target.startswith(('https://', 'http://', '#')):
            continue
        assert target == 'validation.json' or (file.parent / target.split('#')[0]).exists(), (file.name, target)
        links += 1
secret = re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|nvapi-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')
for file in root.iterdir():
    if file.suffix in {'.md', '.json', '.log', '.py', '.ts'}:
        assert not secret.search(file.read_text()), f'Inspect potential secret in {file.name} locally without disclosure'
# The earlier pack is historical evidence; retain every byte rather than silently refreshing it.
parent_hashes = (root.parent / 'SHA256SUMS').read_text().splitlines()
for line in parent_hashes:
    digest, name = line.split('  ', 1)
    assert hashlib.sha256((root.parent / name).read_bytes()).hexdigest() == digest, name
out = dict(status='PASS', source_sha=sha,
    read_queries=len(runtime['results']) + len(diagnostics['results']) + 1,
    current_existing_poller_tests=13, current_policy_replay_checks=3,
    lesson_threads_7d=lessons['threads'], hermes_replies_7d=usage['hermes-eve-v']['n'],
    native_source_hash_matches_repository=True, reflection_cap=0,
    historical_pack_files_unchanged=len(parent_hashes), local_links=links,
    application_changes=0, production_mutations=0,
    limits='Local consistency, source and isolated policy checks; no fresh visual proof, full CI, real inference trial or causal benefit estimate.')
(root / 'validation.json').write_text(json.dumps(out, indent=2) + '\n')
files = sorted(p for p in root.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
(root / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
print(json.dumps(out, indent=2))
