"""Run with python3 -m unittest discover -s scripts -p 'test_agent_social_poller.py'."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import signal
import subprocess
import time
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

    def test_opencode_custom_provider_is_explicit_isolated_and_secret_scoped(self):
        config_path = None
        def execute(command, prompt, cwd, env):
            nonlocal config_path
            config_path = Path(env['OPENCODE_CONFIG'])
            config = json.loads(config_path.read_text())
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(config['permission'], {'*': 'deny'})
            self.assertEqual(config['enabled_providers'], ['commons-ollama'])
            provider = config['provider']['commons-ollama']
            self.assertEqual(provider['options']['baseURL'], 'http://100.77.58.72:11434/v1')
            self.assertEqual(provider['options']['apiKey'], 'dedicated-provider')
            self.assertIn('qwen2.5:3b', provider['models'])
            self.assertEqual(command[-2:], ['--model', 'commons-ollama/qwen2.5:3b'])
            self.assertIn('--pure', command)
            for secret in ('private-social', 'private-operator', 'private-paperclip', 'unrelated-provider', 'dedicated-provider'):
                self.assertNotIn(secret, json.dumps(env))
            self.assertEqual(env['XDG_DATA_HOME'], cwd)
            return json.dumps({'type': 'text', 'sessionID': 'native-opencode-run', 'part': {'text': json.dumps(REPLY)}})
        settings = {'SOCIAL_OPENCODE_PROVIDER_URL': 'http://100.77.58.72:11434/v1',
                    'SOCIAL_MODEL_ID': 'commons-ollama/qwen2.5:3b', 'SOCIAL_OPENCODE_PROVIDER_API_KEY': 'dedicated-provider',
                    'DJIMITFLO_SOCIAL_TOKEN': 'private-social', 'DJIMITFLO_COMMONS_OPERATOR_LOGIN': 'private-operator',
                    'PAPERCLIP_API_KEY': 'private-paperclip', 'OPENAI_API_KEY': 'unrelated-provider'}
        with patch.dict(os.environ, settings, clear=True), patch.object(poller.shutil, 'which', return_value='/bin/opencode'), patch.object(poller, 'bounded_process', side_effect=execute):
            _, run_id, _ = poller.run_cli('opencode', 'peer input')
            self.assertEqual(run_id, 'native-opencode-run')
        self.assertFalse(config_path.exists())

    def test_opencode_provider_rejects_unsafe_transport_and_config_substitution(self):
        settings = {'SOCIAL_MODEL_ID': 'commons-ollama/qwen2.5:3b'}
        with patch.dict(os.environ, settings, clear=True):
            for url in ('http://public.example/v1', 'http://8.8.8.8/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'file:///etc/passwd', 'https://example.com/{env:SECRET}', 'https://example.com:invalid/v1'):
                with self.subTest(url=url), patch.dict(os.environ, {'SOCIAL_OPENCODE_PROVIDER_URL': url}), self.assertRaises(RuntimeError):
                    poller.opencode_provider_config()
            for url in ('http://127.0.0.1:11434/v1', 'http://100.77.58.72:11434/v1', 'https://ollama.com/v1'):
                with patch.dict(os.environ, {'SOCIAL_OPENCODE_PROVIDER_URL': url}):
                    self.assertNotIn('apiKey', poller.opencode_provider_config()['provider']['commons-ollama']['options'])
            with patch.dict(os.environ, {'SOCIAL_OPENCODE_PROVIDER_URL': 'https://ollama.com/v1', 'SOCIAL_MODEL_ID': 'other/model'}), self.assertRaises(RuntimeError):
                poller.opencode_provider_config()
            with patch.dict(os.environ, {'SOCIAL_OPENCODE_PROVIDER_URL': 'https://ollama.com/v1', 'SOCIAL_OPENCODE_PROVIDER_API_KEY': 'private', 'DJIMITFLO_SOCIAL_TOKEN': 'private'}), self.assertRaises(RuntimeError):
                poller.opencode_provider_config()

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

    def test_sigterm_stops_detached_runtime_and_its_worker(self):
        with tempfile.TemporaryDirectory() as cwd:
            pid_file = Path(cwd) / 'pids.json'
            worker = "import subprocess,sys,os,json,time; from pathlib import Path; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); Path(sys.argv[1]).write_text(json.dumps([os.getpid(),child.pid])); time.sleep(30)"
            controller = "import importlib.util,sys; s=importlib.util.spec_from_file_location('poller',sys.argv[1]); p=importlib.util.module_from_spec(s); s.loader.exec_module(p); p.bounded_process([sys.executable,'-c',sys.argv[2],sys.argv[3]],'',sys.argv[4],{},timeout=20)"
            child = subprocess.Popen([sys.executable, '-c', controller, str(Path(poller.__file__).resolve()), worker, str(pid_file), cwd])
            pids = []
            try:
                deadline = time.monotonic() + 5
                while not pid_file.exists() and time.monotonic() < deadline: time.sleep(0.01)
                self.assertTrue(pid_file.exists(), 'runtime did not start')
                pids = json.loads(pid_file.read_text())
                child.terminate()
                self.assertEqual(child.wait(timeout=3), 128 + signal.SIGTERM)
                for pid in pids:
                    deadline = time.monotonic() + 2
                    while True:
                        status = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
                        if not status or status.startswith('Z') or time.monotonic() >= deadline: break
                        time.sleep(0.01)
                    self.assertTrue(not status or status.startswith('Z'), f'worker {pid} survived cancellation')
            finally:
                if child.poll() is None: child.kill(); child.wait()
                for pid in pids:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_timeout_kills_worker(self):
        with tempfile.TemporaryDirectory() as cwd:
            with self.assertRaisesRegex(RuntimeError, 'timeout'):
                poller.bounded_process([sys.executable, '-c', 'import time; time.sleep(10)'], '', cwd, {}, timeout=0.05)


if __name__ == '__main__':
    unittest.main()
