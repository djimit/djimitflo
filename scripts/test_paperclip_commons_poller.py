import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('paperclip-commons-poller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

class ControllerTests(unittest.TestCase):
    def test_authority_secrets_removed_before_runtime(self):
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"operator","password":"secret"}',
               'PAPERCLIP_RUN_ID': 'run', 'PAPERCLIP_API_KEY': 'run-secret', 'PAPERCLIP_AGENT_ID': 'agent',
               'DJIMITFLO_SOCIAL_TOKEN': 'stale', 'OPENAI_API_KEY': 'cloud-secret', 'NODE_OPTIONS': '--evil',
               'SOCIAL_MODEL_ID': 'arbitrary', 'PATH': '/usr/bin', 'SOCIAL_OPENCODE_PROVIDER_API_KEY': 'provider-only'}
        with patch.dict(os.environ, env, clear=True):
            login, run, token, agent = c.isolate_environment()
            self.assertEqual(token, 'run-secret')
            for name in ('DJIMITFLO_COMMONS_OPERATOR_LOGIN', 'PAPERCLIP_API_KEY', 'PAPERCLIP_RUN_ID', 'DJIMITFLO_SOCIAL_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS'):
                self.assertNotIn(name, os.environ)
            self.assertEqual(os.environ['SOCIAL_OPENCODE_PROVIDER_API_KEY'], 'provider-only')
            poller_spec = importlib.util.spec_from_file_location('poller', Path(__file__).with_name('agent-social-poller.py'))
            poller = importlib.util.module_from_spec(poller_spec)
            poller_spec.loader.exec_module(poller)
            self.assertNotIn('SOCIAL_OPENCODE_PROVIDER_API_KEY', poller.runtime_env('opencode'))
            self.assertEqual(os.environ['SOCIAL_MODEL_ID'], c.MODEL)
            self.assertEqual(os.environ['DJIMITFLO_AGENT_ID'], c.AGENT)

    def test_pending_message_never_creates_round_and_only_one_model_call(self):
        p = Mock()
        msg = {'id': 'one', 'deliveryLeaseToken': 'lease'}
        p.api.side_effect = [(200, {}), (200, {'messages': [msg, {'id': 'two'}]}), (201, {'message': {'payload': {'action': 'social.response'}}})]
        p.run_cli.return_value = ('json', 'runtime', {'total': 10})
        p.extract_object.return_value = {'answer': 'a'}
        with patch.object(c, 'request') as request:
            result = c.poll_once(p, 'operator-secret')
        request.assert_not_called()
        p.run_cli.assert_called_once()
        self.assertEqual(result['model_calls'], 1)
        self.assertEqual(p.api.call_args.args[2]['delivery_lease_token'], 'lease')

    def test_empty_inbox_creates_one_fixed_round_then_no_inference_if_still_empty(self):
        p = Mock()
        p.api.return_value = (200, {'messages': []})
        with patch.object(c, 'request') as request:
            result = c.poll_once(p, 'operator-secret')
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[3]['participant_ids'], [c.AGENT, c.PEER])
        p.run_cli.assert_not_called()
        self.assertEqual(result['model_calls'], 0)

    def test_failed_checkout_never_mutates_issue(self):
        calls = []
        def request(method, base, path, body=None, token=None, run_id=None):
            calls.append((method, path))
            if method == 'GET': return {'agentId': 'agent', 'contextSnapshot': {'issueId': 'issue'}}
            raise RuntimeError('ownership conflict')
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"operator","password":"secret"}',
               'PAPERCLIP_RUN_ID': 'run', 'PAPERCLIP_API_KEY': 'run-secret', 'PAPERCLIP_AGENT_ID': 'agent'}
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', side_effect=request):
            self.assertEqual(c.main(), 1)
        self.assertFalse(any(method == 'PATCH' for method, path in calls))

    def test_owned_issue_closes_done_or_blocked(self):
        for fails in (False, True):
            calls = []
            def request(method, base, path, body=None, token=None, run_id=None):
                calls.append((method, path, body))
                if path.startswith('/api/heartbeat-runs/'): return {'agentId': 'agent', 'contextSnapshot': {'issueId': 'issue'}}
                return {'token': 'token'}
            env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"operator","password":"secret"}',
                   'PAPERCLIP_RUN_ID': 'run', 'PAPERCLIP_API_KEY': 'run-secret', 'PAPERCLIP_AGENT_ID': 'agent'}
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', side_effect=request), patch.object(c, 'poll_once', side_effect=RuntimeError('model failed') if fails else None, return_value={'processed': 1}):
                self.assertEqual(c.main(), 1 if fails else 0)
            patches = [body for method, path, body in calls if method == 'PATCH']
            self.assertEqual(patches[0]['status'], 'blocked' if fails else 'done')
            if fails: self.assertEqual(patches[0]['unblockDescriptor']['owner'], 'board')

    def test_failure_categories_never_expose_provider_body(self):
        self.assertEqual(c.failure_code(RuntimeError('Djimitflo HTTP 422: secret value')), 'http_422')
        self.assertEqual(c.failure_code(RuntimeError('runtime returned no JSON object')), 'reply_not_json')
        self.assertEqual(c.failure_code(RuntimeError('unexpected secret value')), 'unclassified')

    def test_rejected_blocking_records_reason_and_attempts_run_comment(self):
        calls = []
        def request(method, base, path, body=None, token=None, run_id=None):
            calls.append((method, path, body))
            if path.startswith('/api/heartbeat-runs/'): return {'agentId': 'agent', 'contextSnapshot': {'issueId': 'issue'}}
            if method == 'PATCH': raise RuntimeError('PATCH /api/issues/issue HTTP 422')
            return {'token': 'token'}
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"operator","password":"secret"}',
               'PAPERCLIP_RUN_ID': 'run', 'PAPERCLIP_API_KEY': 'run-secret', 'PAPERCLIP_AGENT_ID': 'agent'}
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', side_effect=request), patch.object(c, 'poll_once', side_effect=RuntimeError('runtime returned no JSON object')):
            self.assertEqual(c.main(), 1)
        comment = calls[-1]
        self.assertEqual(comment[1], '/api/issues/issue/comments')
        self.assertIn('http_422', comment[2]['body'])
        self.assertIn('reply_not_json', comment[2]['body'])

    def test_renewal_uses_only_fixed_target_and_short_ttl(self):
        calls = []
        def request(method, base, path, body=None, token=None, run_id=None):
            calls.append((path, body, token))
            if path.startswith('/api/heartbeat-runs/'): return {'agentId': 'agent'}
            if path == '/api/auth/login': return {'token': 'operator-secret'}
            return {'token': 'scoped-secret'}
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"operator","password":"secret"}',
               'PAPERCLIP_RUN_ID': 'run', 'PAPERCLIP_API_KEY': 'run-secret', 'PAPERCLIP_AGENT_ID': 'agent'}
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', side_effect=request), patch.object(c, 'poll_once', return_value={'processed': 0}):
            self.assertEqual(c.main(), 0)
            self.assertNotIn('DJIMITFLO_SOCIAL_TOKEN', os.environ)
        self.assertEqual(calls[-1], ('/api/swarm-v2/social/agents/opencode-control/token', {'ttl_ms': 900000}, 'operator-secret'))

if __name__ == '__main__': unittest.main()
