#!/bin/bash
# Installs Zen Tidy: the loader into Zen.app, and the script and styles into the default profile.
# Usage: zen/install.sh [profile-dir]   Uninstall steps: zen/README.md.
set -euo pipefail

ZEN_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$ZEN_DIR")"
RESOURCES="/Applications/Zen.app/Contents/Resources"
PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  matches=("$HOME/Library/Application Support/zen/Profiles/"*"Default (release)")
  if [ "${#matches[@]}" -ne 1 ] || [ ! -d "${matches[0]}" ]; then
    echo "Pass the profile directory: found ${#matches[@]} Default (release) profiles" >&2
    exit 1
  fi
  PROFILE="${matches[0]}"
fi

if [ -f "$RESOURCES/config.js" ] && ! grep -q "Zen Tidy loader" "$RESOURCES/config.js"; then
  echo "Another loader already owns $RESOURCES/config.js; not overwriting it" >&2
  exit 1
fi
mkdir -p "$RESOURCES/defaults/pref"
cp "$ZEN_DIR/loader/config.js" "$RESOURCES/config.js"
cp "$ZEN_DIR/loader/config-prefs.js" "$RESOURCES/defaults/pref/config-prefs.js"

mkdir -p "$PROFILE/chrome/JS"
ln -sfn "$ZEN_DIR/zen-tidy.uc.js" "$PROFILE/chrome/JS/zen-tidy.uc.js"
ln -sfn "$ZEN_DIR/zen-tidy.css" "$PROFILE/chrome/zen-tidy.css"

USER_CHROME="$PROFILE/chrome/userChrome.css"
IMPORT_LINE='@import url("zen-tidy.css");'
touch "$USER_CHROME"
if ! grep -qF "$IMPORT_LINE" "$USER_CHROME"; then
  # @import must come before every other rule.
  { echo "$IMPORT_LINE"; cat "$USER_CHROME"; } > "$USER_CHROME.tmp" && mv "$USER_CHROME.tmp" "$USER_CHROME"
fi

USER_JS="$PROFILE/user.js"
touch "$USER_JS"
for pref in \
  'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);' \
  "user_pref(\"zen.tidy.repo-dir\", \"$REPO_DIR\");"; do
  key="${pref%%,*}"
  grep -qF "$key" "$USER_JS" || echo "$pref" >> "$USER_JS"
done

echo "Installed. Restart Zen to load it."
