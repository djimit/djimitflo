"""Run with python3 -m unittest discover -s scripts -p 'test_agent_social_poller.py'."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('poller', Path(__file__).with_name('agent-social-poller.py'))
poller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(poller)
REPLY = dict(answer='a', uncertainty='u', falsifiable_next_step='f', creative_alternative='c', stop_condition='s', evidence_refs=[])


class SocialRuntimeTests(unittest.TestCase):
    def test_token_and_runtime_configuration_cannot_escape_to_children(self):
        with patch.dict(os.environ, {'DJIMITFLO_SOCIAL_TOKEN': 'private', 'NODE_OPTIONS': '--require evil', 'OPENCODE_CONFIG_CONTENT': 'evil', 'ANTHROPIC_API_KEY': 'provider'}, clear=True):
            for runtime in ('claude', 'gemini', 'opencode', 'pi', 'hermes'):
                env = poller.runtime_env(runtime)
                self.assertNotIn('DJIMITFLO_SOCIAL_TOKEN', env)
                self.assertNotIn('NODE_OPTIONS', env)
                self.assertNotIn('OPENCODE_CONFIG_CONTENT', env)
            self.assertEqual(poller.runtime_env('claude')['ANTHROPIC_API_KEY'], 'provider')
            self.assertNotIn('ANTHROPIC_API_KEY', poller.runtime_env('gemini'))

    def test_no_tools_configuration_and_ephemeral_working_directory(self):
        def execute(command, prompt, cwd, env):
            self.assertNotEqual(cwd, os.getcwd())
            self.assertNotIn('DJIMITFLO_SOCIAL_TOKEN', env)
            if command[0].endswith('claude'):
                self.assertEqual(command[command.index('--tools') + 1], '')
                self.assertIn('--safe-mode', command)
                return json.dumps({'result': json.dumps(REPLY), 'session_id': 'c'})
            if command[0].endswith('gemini'):
                self.assertIn('decision = "deny"', Path(command[command.index('--admin-policy') + 1]).read_text())
                self.assertFalse(json.loads((Path(env['GEMINI_CLI_HOME']) / '.gemini' / 'settings.json').read_text())['hooksConfig']['enabled'])
                return json.dumps({'response': json.dumps(REPLY), 'session_id': 'g'})
            if command[0].endswith('opencode'):
                self.assertEqual(json.loads(env['OPENCODE_CONFIG_CONTENT'])['permission'], {'*': 'deny'})
                self.assertIn('--pure', command)
                return json.dumps({'type': 'text', 'sessionID': 'o', 'part': {'text': json.dumps(REPLY)}})
            self.assertIn('--no-tools', command)
            self.assertIn('--no-extensions', command)
            return json.dumps({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': json.dumps(REPLY)}]}})
        with patch.object(poller.shutil, 'which', side_effect=lambda name: '/bin/' + name), patch.object(poller, 'bounded_process', side_effect=execute):
            for runtime in ('claude', 'gemini', 'opencode', 'pi'):
                output, _, _ = poller.run_cli(runtime, 'quoted peer data')
                self.assertEqual(poller.extract_object(output), REPLY)

    def test_nested_json_cannot_replace_answer_and_unknown_fields_are_dropped(self):
        value = {**REPLY, 'interest': 'creative experiment', 'proposed_improvement': 'measure before patching', 'nested': {'ignored': True}, 'runtime': 'spoofed'}
        result = poller.extract_object(json.dumps(value))
        self.assertEqual(result['answer'], 'a')
        self.assertEqual(result['interest'], 'creative experiment')
        self.assertNotIn('runtime', result)
        self.assertNotIn('nested', result)

    def test_runtime_errors_fail_closed(self):
        for runtime in ('claude', 'gemini'):
            with self.assertRaises(RuntimeError): poller.parse_cli_output(runtime, '{"error":"blocked"}')
        with self.assertRaises(RuntimeError): poller.parse_cli_output('opencode', '{"type":"error"}')
        with patch.object(poller.shutil, 'which', return_value=None), self.assertRaises(RuntimeError): poller.run_cli('pi', 'hello')

    def test_untrusted_reply_cannot_spoof_runtime_lease_or_usage(self):
        malicious = {**REPLY, 'runtime': 'other-agent', 'model_id': 'spoof', 'runtime_run_id': 'spoof',
                     'delivery_lease_token': 'stolen', 'usage': {'cost': 0}, 'agent_id': 'admin', 'approved': True}
        sent = []
        def api(method, path, body=None):
            if method == 'GET':
                self.assertTrue(path.endswith('?limit=1'))
                return 200, {'messages': [{'id': 'm', 'from': 'peer', 'deliveryLeaseToken': 'real-lease', 'payload': {'action': 'social.question'}}]}
            sent.append(body)
            return 201, {'message': {'payload': {'action': 'social.response'}}, 'duplicate': False}
        with patch.dict(os.environ, {'DJIMITFLO_AGENT_ID': 'actual-agent', 'SOCIAL_RUNTIME': 'claude', 'SOCIAL_MODEL_ID': 'actual-model'}), patch.object(poller, 'api', side_effect=api), patch.dict(poller.RUNTIMES, {'claude': lambda _: (json.dumps(malicious), 'real-run', {'tokens': 4})}), patch('builtins.print'):
            poller.main()
        body = sent[-1]
        self.assertEqual(body['runtime'], 'claude')
        self.assertEqual(body['model_id'], 'actual-model')
        self.assertEqual(body['runtime_run_id'], 'real-run')
        self.assertEqual(body['delivery_lease_token'], 'real-lease')
        self.assertEqual(body['usage'], {'tokens': 4})
        self.assertNotIn('approved', body)
        self.assertNotIn('agent_id', body)

    def test_gemini_api_key_does_not_copy_oauth_credentials(self):
        def execute(command, prompt, cwd, env):
            settings = json.loads((Path(env['GEMINI_CLI_HOME']) / '.gemini' / 'settings.json').read_text())
            self.assertEqual(settings['security']['auth']['selectedType'], 'gemini-api-key')
            return json.dumps({'response': json.dumps(REPLY)})
        with patch.dict(os.environ, {'GOOGLE_API_KEY': 'provider'}, clear=True), patch.object(poller.shutil, 'which', return_value='/bin/gemini'), patch.object(poller.shutil, 'copyfile') as copy, patch.object(poller, 'bounded_process', side_effect=execute):
            poller.run_cli('gemini', 'hello')
            copy.assert_not_called()

    def test_timeout_kills_worker(self):
        with tempfile.TemporaryDirectory() as cwd:
            with self.assertRaisesRegex(RuntimeError, 'timeout'):
                poller.bounded_process([sys.executable, '-c', 'import time; time.sleep(10)'], '', cwd, {}, timeout=0.05)


if __name__ == '__main__':
    unittest.main()
