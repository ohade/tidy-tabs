#!/usr/bin/env python3
"""Probe the native host using the same argv and framing Chrome uses."""

import json
from pathlib import Path
import struct
import subprocess
import sys


def main():
    if len(sys.argv) != 3:
        print("Usage: probe_host.py HOST_PATH CHROME_EXTENSION_ORIGIN", file=sys.stderr)
        return 2

    host = Path(sys.argv[1]).resolve()
    origin = sys.argv[2]
    payload = json.dumps({"action": "status"}).encode("utf-8")
    framed_request = struct.pack("<I", len(payload)) + payload

    try:
        completed = subprocess.run(
            [str(host), origin],
            input=framed_request,
            capture_output=True,
            timeout=20,
            cwd=host.parent,
            check=False,
        )
    except subprocess.TimeoutExpired:
        print("Native host status probe timed out", file=sys.stderr)
        return 1

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        print("Native host status probe failed: %s" % (detail or completed.returncode), file=sys.stderr)
        return 1
    if len(completed.stdout) < 4:
        print("Native host status probe returned no framed response", file=sys.stderr)
        return 1

    length = struct.unpack("<I", completed.stdout[:4])[0]
    payload = completed.stdout[4:]
    if len(payload) != length:
        print("Native host status probe returned an invalid frame", file=sys.stderr)
        return 1
    try:
        response = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        print("Native host status probe returned invalid JSON: %s" % exc, file=sys.stderr)
        return 1
    if not response.get("ok"):
        print("Native host is not ready: %s" % response.get("error", "unknown error"), file=sys.stderr)
        return 1

    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
