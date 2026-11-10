import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

HELPER_PATH = Path(__file__).resolve().parents[1] / "zen" / "zen_tidy_claude.py"
spec = importlib.util.spec_from_file_location("zen_tidy_claude", HELPER_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

TABS = [
    {"id": 1, "title": "ABC-123 fix login - Jira", "url": "https://jira.example/browse/ABC-123"},
    {"id": 2, "title": "Pull request #9: ABC-123 fix login", "url": "https://git.example/pr/9"},
]
ANSWER = {
    "groups": [{"name": "ABC-123 Login Fix", "color": "blue", "tab_ids": [1, 2]}],
    "names": [{"tab_id": 1, "short_name": "ABC-123 ticket"}, {"tab_id": 2, "short_name": "PR 9"}],
}


def completed(stdout, returncode=0, stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


class PromptTest(unittest.TestCase):
    def test_prompt_asks_for_groups_and_short_names_for_every_tab(self):
        prompt = helper.build_prompt(TABS)
        self.assertIn("Every tab ID must appear exactly once", prompt)
        self.assertIn("short_name", prompt)
        self.assertIn("1. ABC-123 fix login - Jira", prompt)

    def test_prompt_lists_existing_folders_and_allows_new_ones(self):
        folders = [{"name": "Israeli News", "color": "grey", "titles": ["ynet front page", "haaretz"]}]
        prompt = helper.build_prompt(TABS, folders)
        self.assertIn("Existing groups:", prompt)
        self.assertIn("- Israeli News (grey): ynet front page; haaretz", prompt)
        self.assertIn("When no existing group fits, create a new specific group", prompt)

    def test_prompt_without_folders_has_no_existing_group_section(self):
        self.assertNotIn("Existing groups:", helper.build_prompt(TABS, []))


class RunClaudeTest(unittest.TestCase):
    def test_runs_haiku_without_tools_hooks_or_mcp_and_returns_structured_output(self):
        stdout = json.dumps({"type": "result", "is_error": False, "structured_output": ANSWER})
        with mock.patch.object(helper.subprocess, "run", return_value=completed(stdout)) as run:
            result = helper.run_claude("PROMPT")
        self.assertEqual(result, ANSWER)
        argv = run.call_args.args[0]
        self.assertIn("-p", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "haiku")
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "project")
        self.assertIn("--strict-mcp-config", argv)
        self.assertIn("--no-session-persistence", argv)
        schema = json.loads(argv[argv.index("--json-schema") + 1])
        self.assertIn("names", schema["required"])
        self.assertEqual(run.call_args.kwargs["input"], "PROMPT")

    def test_failed_cli_raises_with_its_error_text(self):
        with mock.patch.object(helper.subprocess, "run", return_value=completed("", 1, "Not logged in")):
            with self.assertRaisesRegex(helper.ClaudeError, "Not logged in"):
                helper.run_claude("PROMPT")

    def test_result_without_structured_output_raises(self):
        stdout = json.dumps({"type": "result", "is_error": False, "result": "sorry"})
        with mock.patch.object(helper.subprocess, "run", return_value=completed(stdout)):
            with self.assertRaises(helper.ClaudeError):
                helper.run_claude("PROMPT")


class MainTest(unittest.TestCase):
    def run_main(self, stdin_text):
        out = io.StringIO()
        with mock.patch.object(helper.sys, "stdin", io.StringIO(stdin_text)), \
                mock.patch.object(helper.sys, "stdout", out):
            code = helper.main()
        return code, json.loads(out.getvalue())

    def test_prints_answer_for_valid_tabs(self):
        with mock.patch.object(helper, "run_claude", return_value=ANSWER):
            code, payload = self.run_main(json.dumps({"tabs": TABS}))
        self.assertEqual(code, 0)
        self.assertEqual(payload, {"ok": True, **ANSWER})

    def test_sends_existing_folders_to_claude(self):
        folders = [{"name": "Israeli News", "color": "grey", "titles": ["ynet"]}]
        with mock.patch.object(helper, "run_claude", return_value=ANSWER) as run:
            self.run_main(json.dumps({"tabs": TABS, "folders": folders}))
        self.assertIn("- Israeli News (grey): ynet", run.call_args.args[0])

    def test_rejects_non_consecutive_tab_ids(self):
        bad = [dict(TABS[0], id=2)]
        code, payload = self.run_main(json.dumps({"tabs": bad}))
        self.assertEqual(code, 1)
        self.assertFalse(payload["ok"])

    def test_reports_claude_failure(self):
        with mock.patch.object(helper, "run_claude", side_effect=helper.ClaudeError("boom")):
            code, payload = self.run_main(json.dumps({"tabs": TABS}))
        self.assertEqual(code, 1)
        self.assertEqual(payload, {"ok": False, "error": "boom"})


if __name__ == "__main__":
    unittest.main()
