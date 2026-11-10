#!/usr/bin/env python3
"""Zen Tidy helper: asks Claude Haiku to group tabs and give each a short name.

Reads {"tabs": [{"id", "title", "url"}, ...]} on stdin and prints one JSON object:
{"ok": true, "groups": [...], "names": [...]} or {"ok": false, "error": "..."}.
Zen's browser script spawns it; it reuses the Chrome extension's grouping prompt.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from tidy_tabs_host import classification_prompt, validate_tabs  # noqa: E402

CLAUDE_TIMEOUT_SECONDS = 120
COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]
SCHEMA = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "color": {"type": "string", "enum": COLORS},
                    "tab_ids": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["name", "color", "tab_ids"],
                "additionalProperties": False,
            },
        },
        "names": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tab_id": {"type": "integer"},
                    "short_name": {"type": "string"},
                },
                "required": ["tab_id", "short_name"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["groups", "names"],
    "additionalProperties": False,
}
SHORT_NAME_RULES = """
Also return "names": one entry per tab ID with a short_name for the tab.
- A short_name is 1-4 words and at most 30 characters, like a label a person would write.
- Keep identifiers that tell tabs apart: ticket keys (ABC-123), PR numbers, repo or dashboard names.
- Drop site names, separators, and filler such as "Dashboard -", "| Jira", or "Pull Request".
- Give tabs in the same group different short_names when their pages differ.
"""


class ClaudeError(Exception):
    pass


def claude_binary():
    return os.environ.get("ZEN_TIDY_CLAUDE_BIN", "/opt/homebrew/bin/claude")


def build_prompt(tabs):
    return classification_prompt(tabs) + SHORT_NAME_RULES


def run_claude(prompt):
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
    argv = [
        claude_binary(), "-p",
        "--model", os.environ.get("ZEN_TIDY_MODEL", "haiku"),
        "--output-format", "json",
        "--json-schema", json.dumps(SCHEMA),
        "--tools", "",
        # An empty project directory keeps the user's hooks, plugins and MCP servers out.
        "--setting-sources", "project",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--system-prompt", "You organize browser tabs. Answer only with the requested JSON.",
    ]
    with tempfile.TemporaryDirectory(prefix="zen-tidy-") as empty_dir:
        try:
            done = subprocess.run(
                argv, input=prompt, text=True, capture_output=True,
                timeout=CLAUDE_TIMEOUT_SECONDS, cwd=empty_dir, env=env, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ClaudeError("Claude did not run: %s" % error) from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "Claude exited with %d" % done.returncode).strip()
        raise ClaudeError(detail[-500:])
    try:
        result = json.loads(done.stdout)
    except json.JSONDecodeError as error:
        raise ClaudeError("Claude returned non-JSON output") from error
    answer = result.get("structured_output")
    if result.get("is_error") or not isinstance(answer, dict):
        raise ClaudeError(str(result.get("result") or "Claude returned no structured answer")[-500:])
    return answer


def main():
    try:
        message = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        message = {}
    tabs, error = validate_tabs(message)
    if error:
        print(json.dumps(error))
        return 1
    try:
        answer = run_claude(build_prompt(tabs))
    except ClaudeError as failure:
        print(json.dumps({"ok": False, "error": str(failure)}))
        return 1
    print(json.dumps({"ok": True, "groups": answer.get("groups", []), "names": answer.get("names", [])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
