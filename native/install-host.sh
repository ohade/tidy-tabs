#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
TARGET="$TARGET_DIR/com.ohade.tidy_tabs.json"

mkdir -p "$TARGET_DIR"
python3 - "$SCRIPT_DIR/com.ohade.tidy_tabs.json" "$TARGET" "$SCRIPT_DIR/tidy_tabs_host.py" <<'PY'
import json
from pathlib import Path
import sys

source, target, host = map(Path, sys.argv[1:])
manifest = json.loads(source.read_text(encoding="utf-8"))
if manifest.get("path") != "__TIDY_TABS_HOST_PATH__":
    raise SystemExit("Native host manifest template has an unexpected path")
manifest["path"] = str(host.resolve())
target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
chmod 644 "$TARGET"
chmod 755 "$SCRIPT_DIR/tidy_tabs_host.py"
python3 -m json.tool "$TARGET" >/dev/null
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$SCRIPT_DIR/tidy_tabs_host.py" --status >/dev/null
ORIGIN=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["allowed_origins"][0])' "$TARGET")
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  python3 "$SCRIPT_DIR/probe_host.py" "$SCRIPT_DIR/tidy_tabs_host.py" "$ORIGIN" >/dev/null
printf 'Installed %s\n' "$TARGET"
