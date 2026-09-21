#!/usr/bin/env python3
"""Deterministic scheduled Commons controller: one bounded OpenCode inference per run.

Runs from any scheduler (systemd timer, launchd, cron) on a host that has the OpenCode CLI. It replaces the former
Paperclip process adapter: admission (daily cap) is enforced here, the operator login stays a secret only this
controller receives, and the runtime child gets a 15-minute scoped token minted per run.

Configuration (environment; secrets via a 0600 EnvironmentFile, never on the command line):
  DJIMITFLO_COMMONS_OPERATOR_LOGIN   {"email":"...","password":"..."}   (required)
  SOCIAL_OPENCODE_PROVIDER_API_KEY   provider key, handed only to the OpenCode child (optional)
  DJIMITFLO_URL (default http://100.86.47.122:3001)   COMMONS_AGENT (opencode-control)   COMMONS_PEER (commons-oracle)
  COMMONS_MODEL (commons-ollama/kimi-k2.6)   COMMONS_PROVIDER_URL (https://ollama.com/v1)   OPENCODE_BIN_PATH (/usr/bin/opencode)
  COMMONS_MAX_RUNS_PER_DAY (4)   COMMONS_STATE_DIR (~/.local/state/commons-poller)
"""
import datetime
import importlib.util
import json
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.request

DEFAULTS = {
    'DJIMITFLO_URL': 'http://100.86.47.122:3001',
    'COMMONS_AGENT': 'opencode-control',
    'COMMONS_PEER': 'commons-oracle',
    'COMMONS_MODEL': 'commons-ollama/kimi-k2.6',
    'COMMONS_PROVIDER_URL': 'https://ollama.com/v1',
    'OPENCODE_BIN_PATH': '/usr/bin/opencode',
    'COMMONS_MAX_RUNS_PER_DAY': '4',
}
CONFIG = {}
AGENT = DEFAULTS['COMMONS_AGENT']
PEER = DEFAULTS['COMMONS_PEER']
MODEL = DEFAULTS['COMMONS_MODEL']
DJIMITFLO = DEFAULTS['DJIMITFLO_URL']


def request(method, base, path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{method} {path} HTTP {error.code}') from None


def failure_code(error):
    """Only fixed categories/numeric HTTP codes; never provider bodies or peer data."""
    message = str(error)
    status = re.search(r'\bHTTP (\d{3})\b', message)
    if status: return 'http_' + status.group(1)
    known = {
        'runtime returned no JSON object': 'reply_not_json',
        'runtime JSON omitted a required social-learning field': 'reply_missing_fields',
        'runtime evidence_refs must be an array': 'reply_invalid_evidence',
        'runtime exceeded bounded execution timeout': 'runtime_timeout',
        'opencode returned an error event': 'provider_error_event',
        'daily run cap reached': 'daily_cap',
    }
    if message in known: return known[message]
    if re.fullmatch(r'opencode failed with exit -?\d+', message): return 'runtime_exit'
    return 'unclassified'


def isolate_environment():
    """Take the secrets out of the process environment before anything else can inherit them."""
    global CONFIG, AGENT, PEER, MODEL, DJIMITFLO
    login = json.loads(os.environ.pop('DJIMITFLO_COMMONS_OPERATOR_LOGIN'))
    provider_key = os.environ.pop('SOCIAL_OPENCODE_PROVIDER_API_KEY', '')
    CONFIG = {key: os.environ.get(key, default) for key, default in DEFAULTS.items()}
    CONFIG['COMMONS_STATE_DIR'] = os.environ.get('COMMONS_STATE_DIR') or str(Path.home() / '.local' / 'state' / 'commons-poller')
    AGENT, PEER, MODEL, DJIMITFLO = CONFIG['COMMONS_AGENT'], CONFIG['COMMONS_PEER'], CONFIG['COMMONS_MODEL'], CONFIG['DJIMITFLO_URL']
    inherited = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    os.environ.clear()
    os.environ.update(inherited)
    os.environ.update(DJIMITFLO_URL=DJIMITFLO, DJIMITFLO_AGENT_ID=AGENT, SOCIAL_RUNTIME='opencode', SOCIAL_MODEL_ID=MODEL,
        SOCIAL_OPENCODE_PROVIDER_URL=CONFIG['COMMONS_PROVIDER_URL'], OPENCODE_BIN_PATH=CONFIG['OPENCODE_BIN_PATH'])
    if provider_key:
        os.environ['SOCIAL_OPENCODE_PROVIDER_API_KEY'] = provider_key
    if not isinstance(login, dict) or set(login) != {'email', 'password'} or not all(isinstance(v, str) and v for v in login.values()):
        raise RuntimeError('Invalid operator login configuration')
    return login


def admit_run(state_dir, today=None, now=None):
    """Daily admission cap (was Paperclip's maxDailyRuns): counts attempts per UTC day in a small state file."""
    day = today or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    limit = int(CONFIG.get('COMMONS_MAX_RUNS_PER_DAY') or DEFAULTS['COMMONS_MAX_RUNS_PER_DAY'])
    path = Path(state_dir) / f'{AGENT}.json'
    try: state = json.loads(path.read_text())
    except (OSError, ValueError): state = {}
    if state.get('day') != day: state = {'day': day, 'runs': 0}
    if state['runs'] >= limit:
        return False
    state['runs'] += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state))
    return True


def poll_once(poller, operator, progress=lambda stage: None):
    progress('social_heartbeat')
    poller.api('POST', f'/api/swarm-v2/social-runtime/{AGENT}/heartbeat', {'runtime': 'opencode', 'model_id': MODEL})
    path = f'/api/swarm-v2/social-runtime/{AGENT}/messages?limit=1'
    progress('claim_inbox')
    _, inbox = poller.api('GET', path)
    if not inbox.get('messages'):
        progress('targeted_round')
        request('POST', DJIMITFLO, '/api/swarm-v2/socialize',
                {'cooldown_ms': 0, 'participant_ids': [AGENT, PEER]}, operator)
        progress('claim_after_round')
        _, inbox = poller.api('GET', path)
    messages = inbox.get('messages', [])
    if not messages:
        return {'agent': AGENT, 'processed': 0, 'model_calls': 0, 'reason': 'no_eligible_message'}
    message = messages[0]
    progress('runtime_inference')
    output, runtime_id, usage = poller.run_cli('opencode', poller.prompt_for(message))
    # Preserve numeric usage even when the subsequent reply validation fails.
    print(json.dumps({'agent': AGENT, 'stage': 'runtime_completed',
        'usage': {key: value for key, value in usage.items()
                  if key in ('total', 'input', 'output', 'reasoning') and type(value) is int and value >= 0}}), flush=True)
    progress('parse_reply')
    reply = poller.extract_object(output)
    reply.update(runtime='opencode', model_id=MODEL, runtime_run_id=runtime_id,
                 usage=usage, delivery_lease_token=message.get('deliveryLeaseToken', ''))
    progress('submit_reply')
    _, result = poller.api('POST', f"/api/swarm-v2/social-runtime/{AGENT}/messages/{message['id']}/respond", reply)
    return {'agent': AGENT, 'processed': 1, 'model_calls': 1, 'message_id': message['id'],
            'runtime_run_id': runtime_id, 'usage': usage, 'output': result['message']['payload']['action']}


def main():
    stage = 'configuration'
    def progress(value):
        nonlocal stage
        stage = value
    try:
        login = isolate_environment()
        progress('admission')
        if not admit_run(CONFIG['COMMONS_STATE_DIR']):
            print(json.dumps({'agent': AGENT, 'processed': 0, 'model_calls': 0, 'reason': 'daily_cap'}))
            return 0
        progress('operator_login')
        operator = request('POST', DJIMITFLO, '/api/auth/login', login)['token']
        login.clear()
        progress('scoped_token_renewal')
        scoped = request('POST', DJIMITFLO, f'/api/swarm-v2/social/agents/{AGENT}/token', {'ttl_ms': 900000}, operator)
        os.environ['DJIMITFLO_SOCIAL_TOKEN'] = scoped['token']
        spec = importlib.util.spec_from_file_location('commons_poller', Path(__file__).with_name('agent-social-poller.py'))
        poller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(poller)
        result = poll_once(poller, operator, progress)
        result.update(token_renewed=True, token_ttl_ms=900000)
        print(json.dumps(result))
    except Exception as error:
        # Never log responses, exception payloads or credential-bearing environment.
        print(json.dumps({'agent': AGENT, 'error_type': type(error).__name__, 'status': 'failed', 'stage': stage, 'failure_code': failure_code(error)}), file=sys.stderr)
        return 1
    finally:
        os.environ.pop('DJIMITFLO_SOCIAL_TOKEN', None)
    return 0

if __name__ == '__main__': sys.exit(main())
