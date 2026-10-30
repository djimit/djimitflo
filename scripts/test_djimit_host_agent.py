"""Run with python3 -m unittest discover -s scripts -p 'test_djimit_host_agent.py'."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host_agent', Path(__file__).with_name('djimit-host-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def shell(text):
    return {"id": "c0ffee00-0000", "kind": "shell", "command": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def env_without_opt_in():
    env = dict(os.environ)
    env.pop("DJIMIT_AGENT_ALLOW_SHELL", None)
    return env


class HostShellOptInTests(unittest.TestCase):
    def test_shell_is_refused_unless_the_host_opts_in(self):
        for value in (None, "0", "true", "yes", ""):
            env = env_without_opt_in()
            if value is not None:
                env["DJIMIT_AGENT_ALLOW_SHELL"] = value
            with patch.dict(os.environ, env, clear=True), patch.object(agent, "run", side_effect=AssertionError("shell must not run")):
                code, out = agent.execute(shell("echo hello"), root=False)
            self.assertNotEqual(code, 0, value)
            self.assertIn("shell_disabled_on_host", out, value)

    def test_shell_runs_when_the_host_opts_in(self):
        with patch.dict(os.environ, {"DJIMIT_AGENT_ALLOW_SHELL": "1"}):
            code, out = agent.execute(shell("echo hello"), root=False)
        self.assertEqual((code, out.strip()), (0, "hello"))

    def test_diagnostics_are_unchanged_without_opt_in(self):
        with patch.dict(os.environ, env_without_opt_in(), clear=True):
            code, out = agent.execute({"kind": "diagnostic", "command": "ping"})
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("pong from "))

    def test_refusal_is_reported_back_as_a_failed_result(self):
        posted = []

        def fake_post(api, path, host, token, body):
            posted.append((path, body))
            return {"commands": [shell("echo hello")]} if path == "/host-agent/poll" else {}

        with tempfile.NamedTemporaryFile("w", suffix=".token", delete=False) as f:
            f.write("tok")
        try:
            argv = ["djimit-host-agent.py", "--once", "--no-root", "--host", "testhost", "--token-file", f.name]
            with patch.dict(os.environ, env_without_opt_in(), clear=True), patch.object(sys, "argv", argv), \
                    patch.object(agent, "post", side_effect=fake_post), patch.object(agent, "host_info", return_value={"os": "linux"}), \
                    patch.object(agent, "run", side_effect=AssertionError("shell must not run")):
                agent.main()
        finally:
            os.unlink(f.name)
        results = [body for path, body in posted if path.endswith("/result")]
        self.assertEqual(len(results), 1)
        self.assertNotEqual(results[0]["exit_code"], 0)
        self.assertIn("shell_disabled_on_host", results[0]["output"])

    def test_selfcheck_passes(self):
        with patch.dict(os.environ, env_without_opt_in(), clear=True):
            agent.selfcheck()


if __name__ == "__main__":
    unittest.main()
