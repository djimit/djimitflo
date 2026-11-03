import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('commons-scheduled-poller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

LOGIN = '{"email":"operator","password":"secret"}'


class ControllerTests(unittest.TestCase):
    def test_authority_secrets_removed_before_runtime(self):
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': LOGIN, 'DJIMITFLO_SOCIAL_TOKEN': 'stale', 'OPENAI_API_KEY': 'cloud-secret',
               'NODE_OPTIONS': '--evil', 'SOCIAL_MODEL_ID': 'arbitrary', 'PATH': '/usr/bin', 'SOCIAL_OPENCODE_PROVIDER_API_KEY': 'provider-only'}
        with patch.dict(os.environ, env, clear=True):
            c.isolate_environment()
            for name in ('DJIMITFLO_COMMONS_OPERATOR_LOGIN', 'DJIMITFLO_SOCIAL_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS'):
                self.assertNotIn(name, os.environ)
            self.assertEqual(os.environ['SOCIAL_OPENCODE_PROVIDER_API_KEY'], 'provider-only')
            poller_spec = importlib.util.spec_from_file_location('poller', Path(__file__).with_name('agent-social-poller.py'))
            poller = importlib.util.module_from_spec(poller_spec)
            poller_spec.loader.exec_module(poller)
            self.assertNotIn('SOCIAL_OPENCODE_PROVIDER_API_KEY', poller.runtime_env('opencode'))
            self.assertEqual(os.environ['SOCIAL_MODEL_ID'], c.MODEL)
            self.assertEqual(os.environ['DJIMITFLO_AGENT_ID'], c.AGENT)

    def test_target_and_model_are_configurable_but_login_is_validated(self):
        with patch.dict(os.environ, {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': LOGIN, 'COMMONS_AGENT': 'other-agent', 'COMMONS_MODEL': 'x/y'}, clear=True):
            c.isolate_environment()
            self.assertEqual((c.AGENT, c.MODEL), ('other-agent', 'x/y'))
        with patch.dict(os.environ, {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': '{"email":"a"}'}, clear=True):
            with self.assertRaises(RuntimeError): c.isolate_environment()
        with patch.dict(os.environ, {}, clear=True):
            c.isolate_environment.__globals__['AGENT'] = 'opencode-control'

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

    def test_invalid_reply_retains_only_allowlisted_numeric_usage(self):
        p = Mock()
        p.api.side_effect = [(200, {}), (200, {'messages': [{'id': 'one'}]})]
        p.run_cli.return_value = ('private output', 'runtime', {'output': 700, 'reasoning': 700, 'input': 'private', 'secret': 42})
        p.extract_object.side_effect = RuntimeError('runtime returned no JSON object')
        with patch('builtins.print') as printed, self.assertRaises(RuntimeError):
            c.poll_once(p, 'operator-secret')
        self.assertEqual(json.loads(printed.call_args.args[0]), {'agent': c.AGENT, 'stage': 'runtime_completed', 'usage': {'output': 700, 'reasoning': 700}})

    def test_empty_inbox_creates_one_fixed_round_then_no_inference_if_still_empty(self):
        p = Mock()
        p.api.return_value = (200, {'messages': []})
        with patch.object(c, 'request') as request:
            result = c.poll_once(p, 'operator-secret')
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[3]['participant_ids'], [c.AGENT, c.PEER])
        p.run_cli.assert_not_called()
        self.assertEqual(result['model_calls'], 0)

    def test_daily_cap_admits_n_runs_then_stops_and_resets_next_day(self):
        with tempfile.TemporaryDirectory() as state, patch.dict(c.CONFIG, {'COMMONS_MAX_RUNS_PER_DAY': '2'}):
            self.assertEqual([c.admit_run(state, today='2026-09-21') for _ in range(3)], [True, True, False])
            self.assertTrue(c.admit_run(state, today='2026-09-22'))

    def test_cap_reached_exits_cleanly_without_login_or_model_call(self):
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': LOGIN, 'COMMONS_MAX_RUNS_PER_DAY': '0'}
        with tempfile.TemporaryDirectory() as state:
            env['COMMONS_STATE_DIR'] = state
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'request') as request, patch('builtins.print') as printed:
                self.assertEqual(c.main(), 0)
            request.assert_not_called()
            self.assertEqual(json.loads(printed.call_args.args[0])['reason'], 'daily_cap')

    def test_failure_categories_never_expose_provider_body(self):
        self.assertEqual(c.failure_code(RuntimeError('Djimitflo HTTP 422: secret value')), 'http_422')
        self.assertEqual(c.failure_code(RuntimeError('runtime returned no JSON object')), 'reply_not_json')
        self.assertEqual(c.failure_code(RuntimeError('unexpected secret value')), 'unclassified')

    def test_failed_run_reports_only_fixed_categories_and_returns_1(self):
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': LOGIN}
        with tempfile.TemporaryDirectory() as state:
            env['COMMONS_STATE_DIR'] = state
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', return_value={'token': 't'}), \
                 patch.object(c, 'poll_once', side_effect=RuntimeError('provider said: secret-value')), patch('sys.stderr') as err:
                self.assertEqual(c.main(), 1)
            written = ''.join(call.args[0] for call in err.write.call_args_list)
            self.assertIn('unclassified', written)
            self.assertNotIn('secret-value', written)

    def test_renewal_uses_only_fixed_target_and_short_ttl(self):
        calls = []
        def request(method, base, path, body=None, token=None):
            calls.append((path, body, token))
            if path == '/api/auth/login': return {'token': 'operator-secret'}
            return {'token': 'scoped-secret'}
        env = {'DJIMITFLO_COMMONS_OPERATOR_LOGIN': LOGIN}
        with tempfile.TemporaryDirectory() as state:
            env['COMMONS_STATE_DIR'] = state
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'request', side_effect=request), patch.object(c, 'poll_once', return_value={'processed': 0}):
                self.assertEqual(c.main(), 0)
                self.assertNotIn('DJIMITFLO_SOCIAL_TOKEN', os.environ)
        self.assertEqual(calls[-1], (f'/api/swarm-v2/social/agents/{c.AGENT}/token', {'ttl_ms': 900000}, 'operator-secret'))


if __name__ == '__main__': unittest.main()
