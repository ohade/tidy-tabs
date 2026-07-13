import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest import mock


HOST_PATH = Path(__file__).resolve().parents[1] / "native" / "tidy_tabs_host.py"
SPEC = importlib.util.spec_from_file_location("tidy_tabs_host", HOST_PATH)
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


class NativeHostTest(unittest.TestCase):
    def test_chrome_origin_runs_native_message_protocol(self):
        payload = json.dumps({"action": "unknown"}).encode("utf-8")
        completed = subprocess.run(
            [sys.executable, str(HOST_PATH), HOST.CHROME_EXTENSION_ORIGIN],
            input=struct.pack("<I", len(payload)) + payload,
            capture_output=True,
            timeout=5,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        length = struct.unpack("<I", completed.stdout[:4])[0]
        response = json.loads(completed.stdout[4:4 + length])
        self.assertEqual(response, {"ok": False, "error": "Unknown action"})

    def test_cli_accepts_only_supported_argument_shapes(self):
        with mock.patch.object(HOST, "main", return_value=0) as main:
            self.assertEqual(HOST.cli([]), 0)
            self.assertEqual(HOST.cli([HOST.CHROME_EXTENSION_ORIGIN]), 0)
            self.assertEqual(main.call_count, 2)

        with (
            mock.patch.object(HOST, "status", return_value={"ok": True}),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(HOST.cli(["--status"]), 0)

        with (
            mock.patch.object(HOST, "main", return_value=0) as main,
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(HOST.cli(["chrome-extension://wrong/"]), 2)
            self.assertEqual(HOST.cli([HOST.CHROME_EXTENSION_ORIGIN, "extra"]), 2)
            self.assertEqual(HOST.cli(["--status", "extra"]), 2)
            main.assert_not_called()

    def test_manifest_key_native_manifest_and_host_origin_match(self):
        extension_manifest = json.loads(
            (HOST_PATH.parents[1] / "manifest.json").read_text(encoding="utf-8")
        )
        digest = hashlib.sha256(base64.b64decode(extension_manifest["key"])).digest()[:16]
        extension_id = "".join(
            chr(ord("a") + nibble)
            for byte in digest
            for nibble in (byte >> 4, byte & 0x0F)
        )
        native_manifest = json.loads(
            (HOST_PATH.parent / "com.ohade.tidy_tabs.json").read_text(encoding="utf-8")
        )

        expected_origin = "chrome-extension://%s/" % extension_id
        self.assertEqual(HOST.CHROME_EXTENSION_ORIGIN, expected_origin)
        self.assertEqual(native_manifest["allowed_origins"], [expected_origin])

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
            captured["command"] = command
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
        self.assertEqual(result["reasoning_effort"], "medium")
        self.assertEqual(captured["env"]["PATH"].split(os.pathsep)[0], "/opt/homebrew/bin")
        model_index = captured["command"].index("--model") + 1
        config_index = captured["command"].index("--config") + 1
        self.assertEqual(captured["command"][model_index], "gpt-5.6-luna")
        self.assertEqual(
            captured["command"][config_index], 'model_reasoning_effort="medium"'
        )

    def test_strict_retry_prompt_requires_recount_and_dynamic_minimum(self):
        tabs = [
            {"id": index, "title": "Tab %d" % index, "url": "https://example.test/%d" % index}
            for index in range(1, 32)
        ]

        prompt = HOST.classification_prompt(tabs, strict_retry=True)

        self.assertIn("These 31 tabs therefore require at least 3 groups", prompt)
        self.assertIn("strict retry", prompt)
        self.assertIn("Needs Review", prompt)

    def test_category_plan_and_allowed_category_prompts(self):
        tabs = [
            {"id": index, "title": "Tab %d" % index, "url": "https://example.test/%d" % index}
            for index in range(1, 62)
        ]
        categories = [
            {
                "name": "Development",
                "description": "Implementation and code changes; excludes passive reading.",
                "color": "blue",
            },
            {
                "name": "Reading",
                "description": "Passive reference material; excludes active implementation.",
                "color": "green",
            },
        ]

        plan_prompt = HOST.category_plan_prompt(tabs, strict_retry=True)
        classify_prompt = HOST.classification_prompt(
            tabs[:10],
            strict_retry=False,
            allowed_categories=categories,
        )

        self.assertIn("Create 8-12 unique categories", plan_prompt)
        self.assertIn("strict retry", plan_prompt)
        self.assertIn("websites, tools, and page formats as evidence", plan_prompt)
        self.assertIn("category boundaries mutually exclusive", plan_prompt)
        self.assertIn("Give every category a short description", plan_prompt)
        self.assertIn("Use only the exact category names", classify_prompt)
        self.assertIn(
            "- Development (blue): Implementation and code changes; excludes passive reading.",
            classify_prompt,
        )
        self.assertIn("underlying intents differ", classify_prompt)

    def test_large_category_plan_scales_with_tab_volume_and_prioritizes_identifiers(self):
        tabs = [
            {"id": index, "title": "Tab %d" % index, "url": "https://example.test/%d" % index}
            for index in range(1, 236)
        ]

        prompt = HOST.category_plan_prompt(tabs)

        self.assertIn("Create 17-27 unique categories", prompt)
        self.assertIn("Aim for roughly 8-16 assigned tabs per category", prompt)
        self.assertIn("exact recurring identifiers", prompt)
        self.assertIn("Do not create page-type categories", prompt)
        self.assertIn("Split broad umbrellas", prompt)

    def test_plan_categories_uses_category_schema(self):
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        captured = {}

        def run(command, **kwargs):
            captured["command"] = command
            captured.update(kwargs)
            output_index = command.index("--output-last-message") + 1
            Path(command[output_index]).write_text(
                '{"categories":[{"name":"Development","description":"Implementation work.","color":"blue"}]}',
                encoding="utf-8",
            )
            return completed

        with (
            mock.patch.object(HOST, "status", return_value={"ok": True}),
            mock.patch.object(HOST, "codex_path", return_value="/opt/homebrew/bin/codex"),
            mock.patch.object(HOST.subprocess, "run", side_effect=run),
        ):
            result = HOST.plan_categories(
                {"tabs": [{"id": 1, "title": "Pull request", "url": "https://example.test"}]}
            )

        schema_index = captured["command"].index("--output-schema") + 1
        self.assertTrue(result["ok"])
        self.assertEqual(result["categories"][0]["name"], "Development")
        self.assertEqual(result["categories"][0]["description"], "Implementation work.")
        self.assertEqual(captured["command"][schema_index], str(HOST.CATEGORY_SCHEMA_PATH))


if __name__ == "__main__":
    unittest.main()
