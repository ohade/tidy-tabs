#!/usr/bin/env python3
"""Chrome Native Messaging host that runs one constrained Codex classification."""

import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile


HOST_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = HOST_DIR / "group-schema.json"
DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_REASONING_EFFORT = "medium"
MAX_TABS = 300
CHROME_EXTENSION_ORIGIN = "chrome-extension://oplpfnkemfoeflcondmciheffcogbfge/"


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) != 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length > 4_000_000:
        raise ValueError("Native message is too large")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("Native message ended early")
    return json.loads(payload.decode("utf-8"))


def write_message(message):
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def codex_path():
    configured = os.environ.get("TIDY_TABS_CODEX_BIN")
    if configured:
        return configured
    return shutil.which("codex") or "/opt/homebrew/bin/codex"


def codex_environment(binary):
    """Return an environment that can launch Homebrew's Node-based Codex CLI."""
    env = os.environ.copy()
    existing = [entry for entry in env.get("PATH", "").split(os.pathsep) if entry]
    candidates = [
        str(Path(binary).expanduser().parent),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    env["PATH"] = os.pathsep.join(
        entry for entry in dict.fromkeys(candidates + existing) if entry not in ("", ".")
    )
    return env


def status():
    binary = codex_path()
    if not Path(binary).is_file():
        return {"ok": False, "error": "Codex CLI is not installed at %s" % binary}
    check = subprocess.run(
        [binary, "login", "status"],
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
        env=codex_environment(binary),
    )
    if check.returncode != 0:
        detail = (check.stderr or check.stdout or "Codex is not logged in").strip()
        return {"ok": False, "error": detail[-500:]}
    return {
        "ok": True,
        "model": os.environ.get("TIDY_TABS_CODEX_MODEL", DEFAULT_MODEL),
        "reasoning_effort": DEFAULT_REASONING_EFFORT,
    }


def clean_text(value, limit):
    return " ".join(str(value or "").replace("\x00", " ").split())[:limit]


def classification_prompt(tabs, strict_retry=False):
    lines = []
    for tab in tabs:
        lines.append("%d. %s (%s)" % (
            tab["id"],
            clean_text(tab.get("title"), 160),
            clean_text(tab.get("url"), 240),
        ))
    minimum_group_count = (len(tabs) + 14) // 15
    retry_instruction = """
This is a strict retry because the previous answer was rejected. Recount every input ID before answering and verify that the output is an exact partition.
""" if strict_retry else ""
    return """Group these browser tabs by the user's likely current intent.

Return only the JSON required by the supplied schema. Rules:
- Every tab ID must appear exactly once, with no duplicates or invented IDs.
- Use specific task/topic names, usually 2-4 words. Infer intent from title, domain, and path.
- Never put more than 15 tabs in one group. These %(tab_count)d tabs therefore require at least %(minimum_group_count)d groups.
- Prefer 6-12 tabs per group when they share a coherent intent; use smaller groups for genuinely distinct tasks.
- Keep searches, tutorials, product pages, social/video pages, news stories, and reference/archive pages separate when their intents differ.
- Keep different languages together only when the underlying task/topic matches.
- Never use Other, Miscellaneous, General, Uncategorized, Various, News & Media, or Needs Review.
- Colors must be one of grey, blue, red, yellow, green, pink, purple, cyan, orange.
- Do not inspect files, run commands, browse the web, or explain the answer.
%(retry_instruction)s

Tabs:
%(tabs)s
""" % {
        "tab_count": len(tabs),
        "minimum_group_count": minimum_group_count,
        "retry_instruction": retry_instruction,
        "tabs": "\n".join(lines),
    }


def classify(message):
    tabs = message.get("tabs")
    if not isinstance(tabs, list) or not tabs or len(tabs) > MAX_TABS:
        return {"ok": False, "error": "Expected between 1 and %d tabs" % MAX_TABS}
    expected_ids = list(range(1, len(tabs) + 1))
    actual_ids = [tab.get("id") for tab in tabs if isinstance(tab, dict)]
    if actual_ids != expected_ids:
        return {"ok": False, "error": "Tab IDs must be consecutive starting at 1"}

    ready = status()
    if not ready["ok"]:
        return ready

    binary = codex_path()
    model = os.environ.get("TIDY_TABS_CODEX_MODEL", DEFAULT_MODEL)
    with tempfile.TemporaryDirectory(prefix="tidy-tabs-codex-") as temp_dir:
        output_path = Path(temp_dir) / "response.json"
        command = [
            binary,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--model",
            model,
            "--config",
            'model_reasoning_effort="%s"' % DEFAULT_REASONING_EFFORT,
            "--output-schema",
            str(SCHEMA_PATH),
            "--output-last-message",
            str(output_path),
            "-",
        ]
        try:
            completed = subprocess.run(
                command,
                input=classification_prompt(tabs, bool(message.get("strict_retry"))),
                text=True,
                capture_output=True,
                timeout=150,
                cwd=temp_dir,
                check=False,
                env=codex_environment(binary),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Codex timed out after 150 seconds"}

        if completed.returncode != 0 or not output_path.exists():
            detail = (completed.stderr or completed.stdout or "Codex produced no output").strip()
            return {"ok": False, "error": "Codex failed: %s" % detail[-800:]}
        try:
            response = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return {"ok": False, "error": "Codex returned invalid JSON: %s" % exc}
        return {
            "ok": True,
            "groups": response.get("groups", []),
            "model": model,
            "reasoning_effort": DEFAULT_REASONING_EFFORT,
        }


def handle(message):
    if not isinstance(message, dict):
        return {"ok": False, "error": "Expected a JSON object"}
    action = message.get("action")
    if action == "status":
        return status()
    if action == "classify":
        return classify(message)
    return {"ok": False, "error": "Unknown action"}


def main():
    try:
        message = read_message()
        if message is None:
            return 0
        write_message(handle(message))
        return 0
    except Exception as exc:
        write_message({"ok": False, "error": "Native host error: %s" % exc})
        return 1


def cli(args=None):
    args = sys.argv[1:] if args is None else args
    if args == ["--status"]:
        result = status()
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1
    if args not in ([], [CHROME_EXTENSION_ORIGIN]):
        print("Usage: tidy_tabs_host.py [--status]", file=sys.stderr)
        return 2
    return main()


if __name__ == "__main__":
    raise SystemExit(cli())
