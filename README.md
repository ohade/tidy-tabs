# Tidy Tabs

One-click AI-powered Chrome tab organizer using Codex. Click the broom icon to sort new, ungrouped tabs into your existing groups (or new ones) and open a visible run report.

Right-click the broom and choose **Re-tidy all tabs** to merge non-incognito windows and regroup every eligible tab from scratch. Existing groups are replaced only after Codex returns a complete, valid classification.

## How It Works

```text
Click broom icon
  -> Validate the local Codex native host
  -> Collect eligible tabs across non-incognito windows (skip pinned tabs and Claude agent groups)
  -> If named groups exist and 50 or fewer tabs are ungrouped:
       classify only the ungrouped tabs, offering the existing groups as categories
       add each tab to its existing group, or create a new group when none fits
  -> Otherwise (or via Re-tidy all tabs), classify every eligible tab:
       50 tabs or fewer: one schema-constrained classification request
       more: one shared taxonomy, then batches of 50 classified in parallel
  -> Retry any invalid plan or batch once
  -> Validate that every tab appears exactly once; keep model-response groups at 15 tabs or fewer
  -> Skip tabs that were closed, navigated, or regrouped while the model ran
  -> Full re-tidy only: merge windows and clear previous eligible groups
  -> Create, fill, and collapse Chrome tab groups
  -> Open (or refresh) the report with status, warnings, group counts, and a CSV export
```

Recognizable browser error pages are separated deterministically and are not sent to the model. Other tab titles are sent to OpenAI through the authenticated Codex CLI, with each URL cut down to its scheme, host, and path. Credentials, query strings, and fragments never leave the browser.

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
- Successful reports can download a CSV containing each tab's assigned group, color, title, and URL.
- A click adds new tabs to existing groups and leaves the rest alone. Nothing new to sort means no model call.
- **Re-tidy all tabs** (right-click the broom) replaces every eligible group. It also runs automatically when there are no named groups yet or more than 50 ungrouped tabs.
- Pinned tabs and groups owned by the Claude browser extension (`Claude`, `Claude (MCP)`, and their ⌛/🔔/✅ variants) are never moved or regrouped. That extension re-creates its group whenever a tab leaves it.
- Tabs closed or changed while the model runs are skipped and listed as a warning instead of failing the run.
- The report reuses its open tab instead of opening a new one each run.
- If both classification attempts are invalid, the run stops before moving tabs or clearing groups.

## Architecture

```text
tidy-tabs/
|-- manifest.json             MV3 permissions and stable extension key
|-- background.js             Click handler, tab merging, grouping, reports
|-- report.{html,css,js}      Visible result/error report
|-- lib/
|   |-- codex.js              Active native-messaging client and validation
|   `-- partition.js          Exact-partition and error-page validation
|-- native/
|   |-- tidy_tabs_host.py     Constrained Codex CLI bridge
|   |-- probe_host.py         Chrome-shaped native-host readiness probe
|   |-- group-schema.json     Structured response contract
|   |-- category-schema.json  Shared taxonomy response contract
|   `-- install-host.sh       Per-user Chrome host installer
`-- icons/                    Static and animated broom icons
```

## Provider Choice

Tidy Tabs runs on Codex only. A local Ollama model gave inconsistent topics and oversized groups, and keeping it resident in the background cost too much for an occasionally used extension. The host uses `gpt-5.6-luna` with medium reasoning. Runs above 50 model-classified tabs first create a shared intent taxonomy with a short, mutually exclusive definition for every category, then assign batches of 50 against those definitions in parallel. The category range scales with tab volume toward roughly 8-16 tabs per final group. Exact ticket, repository, product, and project identifiers outrank website or page type, so a workstream's code, CI, docs, dashboards, and tickets stay together instead of falling into generic operational buckets. Model-response groups stay capped at 15 tabs for assignment reliability, but final assignments are merged into one Chrome group per taxonomy category. Invalid plans or batches retry once, and Chrome is not mutated unless every batch passes exact-partition validation.

## Requirements

- Chrome 146 or newer
- Authenticated Codex CLI
- macOS (the native-host installer renders the current repository path locally)

## License

MIT. See [LICENSE](LICENSE).
