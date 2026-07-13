# Tidy Tabs

One-click AI-powered Chrome tab organizer using Codex. Click the broom icon to merge non-incognito windows, reclassify all eligible tabs, create named and colored groups, and open a visible run report.

Every click is a full re-tidy. Existing groups are ignored and replaced only after Codex returns a complete, valid classification.

## How It Works

```text
Click broom icon
  -> Validate the local Codex native host
  -> Collect eligible tab titles and URLs across non-incognito windows
  -> For 50 tabs or fewer, send one schema-constrained classification request
  -> For larger runs, create one shared taxonomy and classify batches of 50 against it
  -> Retry any invalid plan or batch once
  -> Validate that every tab appears exactly once and no group exceeds 15 tabs
  -> Merge all non-incognito windows into one
  -> Clear previous eligible groups
  -> Create and collapse Chrome tab groups
  -> Open a report with status, warnings, and group counts
```

Recognizable browser error pages are separated deterministically and are not sent to the model. Other tab titles and URLs are sent to OpenAI through the authenticated Codex CLI.

## Prerequisites

1. Install and authenticate the Codex CLI:

   ```bash
   brew install --cask codex
   codex login status
   ```

2. Install the Chrome native messaging host:

   ```bash
   cd ~/git/playground/tidy-tabs
   ./native/install-host.sh
   ```

   The installer verifies Codex using the restricted PATH Chrome native hosts receive. To rerun that check directly:

   ```bash
   env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin ./native/tidy_tabs_host.py --status
   ```

   It also probes the framed native-messaging request with Chrome's caller-origin argument, so installation fails if the host cannot start exactly as Chrome starts it.

3. Open `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select this repository. Reload the extension after host or code updates.

The checked-in manifest key keeps the unpacked extension ID stable so Chrome can authorize the native host.

## Usage

Click the broom icon.

- The broom animates while Codex groups the tabs.
- A green badge shows the group count on success.
- A red `!` badge indicates an error; the opened report contains the full error.
- Invalid classifications include a privacy-safe, attempt-by-attempt explanation of omitted, duplicate, invented, oversized, vague, or malformed assignments.
- Existing eligible tab groups are replaced on every successful run, so clicking again re-tidies the browser.
- If both classification attempts are invalid, the run stops before moving tabs or clearing groups.
- The active provider is `ACTIVE_PROVIDER` in `background.js`.

## Architecture

```text
tidy-tabs/
|-- manifest.json             MV3 permissions and stable extension key
|-- background.js             Click handler, tab merging, grouping, reports
|-- report.{html,css,js}      Visible result/error report
|-- lib/
|   |-- codex.js              Active native-messaging client and validation
|   `-- ollama.js             Disabled Ollama provider retained as fallback
|-- native/
|   |-- tidy_tabs_host.py     Constrained Codex CLI bridge
|   |-- probe_host.py         Chrome-shaped native-host readiness probe
|   |-- group-schema.json     Structured response contract
|   |-- category-schema.json  Shared taxonomy response contract
|   `-- install-host.sh       Per-user Chrome host installer
`-- icons/                    Static and animated broom icons
```

## Provider Choice

Codex is active by default because the local 4B model produced inconsistent topics and oversized groups. The host uses `gpt-5.6-luna` with medium reasoning. Runs above 50 model-classified tabs first create a shared intent taxonomy, then assign batches of 50 only to those categories. Final groups are merged deterministically and split at 15 tabs. Invalid plans or batches retry once, and Chrome is not mutated unless every batch passes exact-partition validation.

The Ollama implementation remains in `lib/ollama.js`. To restore it later, set `ACTIVE_PROVIDER` to `ollama`, reinstall the desired model, start Ollama, and reload the extension. The localhost host permission is deliberately retained for that reversible fallback.

## Requirements

- Chrome 146 or newer
- Authenticated Codex CLI
- macOS (the native-host installer renders the current repository path locally)

## License

MIT. See [LICENSE](LICENSE).
