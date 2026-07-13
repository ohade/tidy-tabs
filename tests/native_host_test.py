import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


HOST_PATH = Path(__file__).resolve().parents[1] / "native" / "tidy_tabs_host.py"
SPEC = importlib.util.spec_from_file_location("tidy_tabs_host", HOST_PATH)
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


class NativeHostTest(unittest.TestCase):
    def test_codex_environment_adds_homebrew_bin_to_restricted_path(self):
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True):
            env = HOST.codex_environment("/opt/homebrew/bin/codex")

        self.assertEqual(env["PATH"].split(os.pathsep)[0], "/opt/homebrew/bin")
        self.assertIn("/usr/bin", env["PATH"].split(os.pathsep))

    def test_status_uses_codex_environment(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            binary = Path(temp_dir) / "codex"
            binary.touch()
            completed = subprocess.CompletedProcess([], 0, stdout="Logged in", stderr="")
            with (
                mock.patch.object(HOST, "codex_path", return_value=str(binary)),
                mock.patch.object(HOST.subprocess, "run", return_value=completed) as run,
                mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True),
            ):
                result = HOST.status()

        self.assertTrue(result["ok"])
        child_path = run.call_args.kwargs["env"]["PATH"].split(os.pathsep)
        self.assertEqual(child_path[0], str(binary.parent))
        self.assertIn("/opt/homebrew/bin", child_path)

    def test_classify_uses_codex_environment(self):
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        captured = {}

        def run(command, **kwargs):
            captured.update(kwargs)
            output_index = command.index("--output-last-message") + 1
            Path(command[output_index]).write_text(
                '{"groups":[{"name":"Work","color":"blue","tab_ids":[1]}]}',
                encoding="utf-8",
            )
            return completed

        with (
            mock.patch.object(HOST, "status", return_value={"ok": True}),
            mock.patch.object(HOST, "codex_path", return_value="/opt/homebrew/bin/codex"),
            mock.patch.object(HOST.subprocess, "run", side_effect=run),
            mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}, clear=True),
        ):
            result = HOST.classify(
                {"tabs": [{"id": 1, "title": "Pull request", "url": "https://example.test"}]}
            )

        self.assertTrue(result["ok"])
        self.assertEqual(captured["env"]["PATH"].split(os.pathsep)[0], "/opt/homebrew/bin")


if __name__ == "__main__":
    unittest.main()
