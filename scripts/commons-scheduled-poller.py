#!/usr/bin/env python3
"""Deterministic scheduled Commons controller: one bounded CLI inference per run (OpenCode by default).

Runs from any scheduler (systemd timer, launchd, cron) on a host that has the OpenCode CLI. It replaces the former
Paperclip process adapter: admission (daily cap) is enforced here, the operator login stays a secret only this
controller receives, and the runtime child gets a 15-minute scoped token minted per run.

Configuration (environment; secrets via a 0600 EnvironmentFile, never on the command line):
  DJIMITFLO_COMMONS_OPERATOR_LOGIN   {"email":"...","password":"..."}   (required)
  SOCIAL_OPENCODE_PROVIDER_API_KEY   provider key, handed only to the OpenCode child (optional)
  DJIMITFLO_URL (default http://100.86.47.122:3001)   COMMONS_AGENT (opencode-control)   COMMONS_PEER (commons-oracle)
  COMMONS_MODEL (commons-ollama/kimi-k2.6)   COMMONS_PROVIDER_URL (https://ollama.com/v1)   OPENCODE_BIN_PATH (/usr/bin/opencode)
  COMMONS_MAX_RUNS_PER_DAY (4)   COMMONS_STATE_DIR (~/.local/state/commons-poller)
  COMMONS_RUNTIME (opencode | claude | codex): claude and codex use the CLI's own login; no provider key reaches them.
  An empty COMMONS_PROVIDER_URL lets OpenCode use its own configured provider. CLAUDE_BIN_PATH / CODEX_BIN_PATH pass through.
  COMMONS_PEER=auto: an empty inbox opens a round with a random agent whose Commons heartbeat is fresh (any host).
  COMMONS_HOURS_UTC (e.g. 6,10,14,18): act only in these UTC hours, so hourly timers on every host meet in the same hour.
"""
import datetime
import importlib.util
import json
import os
import random
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
    'COMMONS_RUNTIME': 'opencode',
    'COMMONS_HOURS_UTC': '',
}
CONFIG = {}
AGENT = DEFAULTS['COMMONS_AGENT']
PEER = DEFAULTS['COMMONS_PEER']
MODEL = DEFAULTS['COMMONS_MODEL']
DJIMITFLO = DEFAULTS['DJIMITFLO_URL']
RUNTIME = DEFAULTS['COMMONS_RUNTIME']


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
        'claude returned an error envelope': 'provider_error_event',
        'codex returned a failed turn': 'provider_error_event',
        'daily run cap reached': 'daily_cap',
    }
    if message in known: return known[message]
    if re.fullmatch(r'(opencode|claude|codex) failed with exit -?\d+', message): return 'runtime_exit'
    return 'unclassified'


def isolate_environment():
    """Take the secrets out of the process environment before anything else can inherit them."""
    global CONFIG, AGENT, PEER, MODEL, DJIMITFLO, RUNTIME
    login = json.loads(os.environ.pop('DJIMITFLO_COMMONS_OPERATOR_LOGIN'))
    provider_key = os.environ.pop('SOCIAL_OPENCODE_PROVIDER_API_KEY', '')
    CONFIG = {key: os.environ.get(key, default) for key, default in DEFAULTS.items()}
    CONFIG['COMMONS_STATE_DIR'] = os.environ.get('COMMONS_STATE_DIR') or str(Path.home() / '.local' / 'state' / 'commons-poller')
    AGENT, PEER, MODEL, DJIMITFLO, RUNTIME = CONFIG['COMMONS_AGENT'], CONFIG['COMMONS_PEER'], CONFIG['COMMONS_MODEL'], CONFIG['DJIMITFLO_URL'], CONFIG['COMMONS_RUNTIME']
    inherited = {key: os.environ[key] for key in ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CLAUDE_BIN_PATH', 'CODEX_BIN_PATH') if key in os.environ}
    os.environ.clear()
    os.environ.update(inherited)
    os.environ.update(DJIMITFLO_URL=DJIMITFLO, DJIMITFLO_AGENT_ID=AGENT, SOCIAL_RUNTIME=RUNTIME, SOCIAL_MODEL_ID=MODEL)
    if RUNTIME == 'opencode':
        os.environ['OPENCODE_BIN_PATH'] = CONFIG['OPENCODE_BIN_PATH']
        if CONFIG['COMMONS_PROVIDER_URL']: os.environ['SOCIAL_OPENCODE_PROVIDER_URL'] = CONFIG['COMMONS_PROVIDER_URL']
    if provider_key and RUNTIME == 'opencode':
        os.environ['SOCIAL_OPENCODE_PROVIDER_API_KEY'] = provider_key
    if RUNTIME not in ('opencode', 'claude', 'codex'): raise RuntimeError('Unsupported COMMONS_RUNTIME')
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


def present_peer(operator, now=None):
    """COMMONS_PEER=auto: a random other agent the server can pair right now (Commons heartbeat within its 20 minutes)."""
    cutoff = ((now or datetime.datetime.now(datetime.timezone.utc)) - datetime.timedelta(minutes=20)).strftime('%Y-%m-%dT%H:%M:%S')
    def present(agent):
        social = (agent.get('metadata') or {}).get('social_runtime') or {}
        return (agent.get('id') != AGENT and agent.get('status') in ('active', 'idle') and not agent.get('retired_at')
                and social.get('enabled') and str(social.get('last_heartbeat_at') or '') >= cutoff)
    # ponytail: random, not least-met; the server's own rounds already prefer pairs that have not met.
    ids = sorted(agent['id'] for agent in request('GET', DJIMITFLO, '/api/agents', None, operator).get('agents', []) if present(agent))
    return random.choice(ids) if ids else None


def poll_once(poller, operator, progress=lambda stage: None):
    progress('social_heartbeat')
    poller.api('POST', f'/api/swarm-v2/social-runtime/{AGENT}/heartbeat', {'runtime': RUNTIME, 'model_id': MODEL})
    path = f'/api/swarm-v2/social-runtime/{AGENT}/messages?limit=1'
    progress('claim_inbox')
    _, inbox = poller.api('GET', path)
    # social.invite is informational (already marked read server-side); only questions/responses need a reply
    actionable = lambda box: [m for m in box.get('messages', []) if (m.get('payload') or {}).get('action') != 'social.invite']
    if not actionable(inbox):
        progress('targeted_round')
        peer = present_peer(operator) if PEER == 'auto' else PEER
        if not peer:
            return {'agent': AGENT, 'processed': 0, 'model_calls': 0, 'reason': 'no_peer_present'}
        request('POST', DJIMITFLO, '/api/swarm-v2/socialize',
                {'cooldown_ms': 0, 'participant_ids': [AGENT, peer]}, operator)
        progress('claim_after_round')
        _, inbox = poller.api('GET', path)
    messages = actionable(inbox)
    if not messages:
        return {'agent': AGENT, 'processed': 0, 'model_calls': 0, 'reason': 'no_eligible_message'}
    message = messages[0]
    progress('runtime_inference')
    output, runtime_id, usage = poller.run_cli(RUNTIME, poller.prompt_for(message))
    # Preserve numeric usage even when the subsequent reply validation fails.
    print(json.dumps({'agent': AGENT, 'stage': 'runtime_completed',
        'usage': {key: value for key, value in usage.items()
                  if key in ('total', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens') and type(value) is int and value >= 0}}), flush=True)
    progress('parse_reply')
    reply = poller.extract_object(output)
    reply.update(runtime=RUNTIME, model_id=MODEL, runtime_run_id=runtime_id,
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
        hours = {int(hour) for hour in CONFIG['COMMONS_HOURS_UTC'].split(',') if hour.strip()}
        if hours and datetime.datetime.now(datetime.timezone.utc).hour not in hours:
            print(json.dumps({'agent': AGENT, 'processed': 0, 'model_calls': 0, 'reason': 'outside_schedule'}))
            return 0
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
