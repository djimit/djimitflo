#!/usr/bin/env python3
"""Deterministic Paperclip process adapter: one OpenCode Commons inference per run.

Scheduling/admission belongs to Paperclip (maxDailyRuns=4, concurrency=1).
Operator login is a Paperclip secret_ref; only this controller receives it.
"""
import importlib.util
import json
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.request

DJIMITFLO = 'http://100.86.47.122:3001'
PAPERCLIP = 'http://127.0.0.1:3100'
AGENT = 'opencode-control'
PEER = 'commons-oracle'
MODEL = 'commons-ollama/deepseek-v4-flash'
PROVIDER = 'https://ollama.com/v1'


def request(method, base, path, body=None, token=None, run_id=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    if run_id: headers['X-Paperclip-Run-Id'] = run_id
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
        'Paperclip run agent mismatch': 'run_identity_mismatch',
    }
    if message in known: return known[message]
    if re.fullmatch(r'opencode failed with exit -?\d+', message): return 'runtime_exit'
    return 'unclassified'


def isolate_environment():
    login = json.loads(os.environ.pop('DJIMITFLO_COMMONS_OPERATOR_LOGIN'))
    provider_key = os.environ.pop('SOCIAL_OPENCODE_PROVIDER_API_KEY', '')
    run_id = os.environ.get('PAPERCLIP_RUN_ID', '')
    run_token = os.environ.pop('PAPERCLIP_API_KEY', '')
    agent_id = os.environ.get('PAPERCLIP_AGENT_ID', '')
    inherited = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    os.environ.clear()
    os.environ.update(inherited)
    os.environ.update(DJIMITFLO_URL=DJIMITFLO, DJIMITFLO_AGENT_ID=AGENT,
        SOCIAL_RUNTIME='opencode', SOCIAL_MODEL_ID=MODEL,
        SOCIAL_OPENCODE_PROVIDER_URL=PROVIDER, OPENCODE_BIN_PATH='/usr/bin/opencode')
    if provider_key:
        os.environ['SOCIAL_OPENCODE_PROVIDER_API_KEY'] = provider_key
    if not isinstance(login, dict) or set(login) != {'email', 'password'} or not all(isinstance(v, str) and v for v in login.values()):
        raise RuntimeError('Invalid operator login configuration')
    if not run_id or not run_token or not agent_id:
        raise RuntimeError('Paperclip run identity required')
    return login, run_id, run_token, agent_id


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
    login, run_id, run_token, paperclip_agent = isolate_environment()
    issue_id = None
    stage = 'paperclip_run_read'
    def progress(value):
        nonlocal stage
        stage = value
    def pc(method, path, body=None):
        return request(method, PAPERCLIP, path, body, run_token, run_id)
    try:
        run = pc('GET', '/api/heartbeat-runs/' + run_id)
        if run.get('agentId') != paperclip_agent: raise RuntimeError('Paperclip run agent mismatch')
        candidate_issue = (run.get('contextSnapshot') or {}).get('issueId')
        if candidate_issue:
            progress('issue_checkout')
            pc('POST', '/api/issues/' + candidate_issue + '/checkout',
               {'agentId': paperclip_agent, 'expectedStatuses': ['todo', 'in_progress', 'backlog']})
            issue_id = candidate_issue
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
        result.update(paperclip_run_id=run_id, token_renewed=True, token_ttl_ms=900000)
        if issue_id:
            progress('issue_done')
            pc('PATCH', '/api/issues/' + issue_id, {'status': 'done', 'comment': json.dumps(result)})
        print(json.dumps(result))
    except Exception as error:
        # Never log responses, exception payloads or credential-bearing environment.
        report = {'agent': AGENT, 'paperclip_run_id': run_id, 'error_type': type(error).__name__, 'status': 'failed', 'stage': stage, 'failure_code': failure_code(error)}
        if issue_id:
            try: pc('PATCH', '/api/issues/' + issue_id, {'status': 'blocked', 'comment': json.dumps(report), 'unblockDescriptor': {'owner': 'board', 'action': 'Diagnose Commons runtime failure, verify provider, then explicitly resume the paused routine.'}})
            except Exception as closure_error:
                report['issue_close_failure_code'] = failure_code(closure_error)
                # A rejected status transition must still leave a run comment;
                # Paperclip otherwise starts a missing-comment remediation run.
                try: pc('POST', '/api/issues/' + issue_id + '/comments', {'body': json.dumps(report)})
                except Exception as comment_error:
                    report['issue_comment_failure_code'] = failure_code(comment_error)
        print(json.dumps(report), file=sys.stderr)
        return 1
    finally:
        os.environ.pop('DJIMITFLO_SOCIAL_TOKEN', None)
    return 0

if __name__ == '__main__': sys.exit(main())
