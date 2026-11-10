# Zen Tidy

A port of Tidy Tabs to the Zen browser. A broom button next to each Space's clean button sends
that Space's unpinned tabs to Claude Haiku. It then files them into colored Zen folders and gives
each tab a short name, the same as **Change Label…** would.

## How it works

- `loader/` is a minimal Firefox autoconfig loader. It runs every `<profile>/chrome/JS/*.uc.js`
  file in each browser window, with full browser privileges.
- `zen-tidy.uc.js` adds the broom, collects the tabs, and applies the plan.
- `zen_tidy_claude.py` runs `claude -p --model haiku` with no tools, no MCP servers, and no user
  hooks. It reuses the Chrome extension's grouping prompt from `native/tidy_tabs_host.py`.
- `tidy-plan.js` turns the model's answer into folders and renames, using `lib/partition.js`.

Needs the Claude Code CLI at `/opt/homebrew/bin/claude`, logged in. Override the path with
`ZEN_TIDY_CLAUDE_BIN` and the model with `ZEN_TIDY_MODEL`.

## Install

```bash
zen/install.sh            # or: zen/install.sh "<profile dir>"
```

Then restart Zen. A Zen update can replace the app bundle and remove the loader; run
`install.sh` again if the broom disappears.

## Uninstall

```bash
rm /Applications/Zen.app/Contents/Resources/config.js \
   /Applications/Zen.app/Contents/Resources/defaults/pref/config-prefs.js
```

Then remove `chrome/JS/zen-tidy.uc.js`, `chrome/zen-tidy.css`, the `@import` line in
`chrome/userChrome.css`, and the `zen.tidy.repo-dir` line in `user.js` from the profile.

## Tests

```bash
node --test tests/zen-tidy-plan.test.js
python3 -m unittest tests/zen_tidy_claude_test.py
```

The browser script and styles are not covered by tests; check them in Zen.
