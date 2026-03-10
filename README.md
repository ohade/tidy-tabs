# Tidy Tabs

One-click AI-powered Chrome tab organizer using a local LLM. Arc browser's "Tidy" feature — fully local, zero API cost.

Click the broom icon → all non-incognito windows merge into one → tabs are classified into named, colored groups → groups collapse.

## How It Works

```
Click broom icon
  → Merge all non-incognito windows into one
  → Collect ungrouped tab titles + URLs
  → Send to local Ollama (Qwen 3.5-9B) in batches of 15
  → Ollama returns JSON: { groups: [{ name, color, tab_ids }] }
  → If >10 groups, consolidation pass merges similar groups into 5-8
  → chrome.tabs.group() + chrome.tabGroups.update() creates named, colored groups
  → All groups collapsed — you see only group names
```

Already-grouped tabs are left untouched.

## Prerequisites

### 1. Install Ollama

```bash
brew install ollama
brew services start ollama
```

### 2. Pull the model

```bash
ollama pull qwen3.5:9b
```

Qwen 3.5-9B: best structured JSON output (IFBench 76.5), 6.6GB, ~40-65 tok/sec on Apple Silicon.

### 3. Allow Chrome extension access

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
brew services restart ollama
```

### 4. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this `tidy-tabs/` directory
4. Pin the broom icon to the toolbar

## Usage

Click the broom icon. That's it.

- Broom animates while working (~8-10s per batch of 15 tabs)
- Green badge with group count when done
- Red `!` badge on error (hover for details)
- Existing tab groups are preserved

## Requirements

- Chrome 146+ (Chrome 145 has a bug where collapsed group titles don't render)
- macOS with Ollama running locally (tested on M4 Pro, 48GB RAM)
- Qwen 3.5-9B model pulled

## Architecture

```
tidy-tabs/
├── manifest.json      # MV3 manifest — tabs, tabGroups, storage permissions
├── background.js      # Service worker — icon click handler, tab merging, grouping
├── lib/
│   └── ollama.js      # Ollama API client — batching, structured output, JSON rescue
└── icons/
    ├── icon{16,48,128}.png    # Static broom icon
    └── frame{0-5}_{16,48}.png # Animation frames
```

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Model | Qwen 3.5-9B | Best instruction following + structured output, fits in 48GB |
| `think: false` | Disabled thinking | 5+ min → 6s response time |
| `num_predict: 4096` | High token limit | Prevents JSON truncation on large batches |
| Batch size 15 | Fixed batches | Balance between quality and speed |
| Consolidation pass | Merge >10 groups → 5-8 | Prevents 30+ tiny groups from batching |
| No popup | Direct icon click | Arc-style UX — one click, no panel |
| JSON regex rescue | Salvage partial output | Even malformed JSON yields usable groups |

## Known Issues

- **JSON parse failures**: Ollama occasionally produces invalid JSON despite `format` schema. The regex rescue extracts complete group objects from partial output.
- **Chrome 145**: Collapsed group titles don't render. Update to Chrome 146+.
