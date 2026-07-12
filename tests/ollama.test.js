const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function loadScript(relativePath, globals = {}) {
  const context = vm.createContext({
    AbortSignal,
    URL,
    console,
    ...globals
  });
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  vm.runInContext(source, context, { filename: relativePath });
  return context;
}

test('checkOllamaReady accepts the configured model', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3.5:4b' }] })
    })
  });

  const result = await vm.runInContext('checkOllamaReady(DEFAULT_MODEL)', context);
  assert.equal(result.ok, true);
});

test('checkOllamaReady reports an actionable missing-model error', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'snowflake-arctic-embed2:568m' }] })
    })
  });

  const result = await vm.runInContext('checkOllamaReady(DEFAULT_MODEL)', context);
  assert.equal(result.ok, false);
  assert.match(result.error, /ollama pull qwen3\.5:4b/);
});

test('classifyBatch includes Ollama response details in its error', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: "model 'qwen3.5:4b' not found" })
    })
  });

  await assert.rejects(
    vm.runInContext("classifyBatch('1. Example (example.com)', DEFAULT_MODEL)", context),
    /Ollama 404: model 'qwen3\.5:4b' not found/
  );
});

test('handleTidy checks Ollama before moving tabs', async () => {
  let moveCalls = 0;
  const context = loadScript('background.js', {
    DEFAULT_MODEL: 'qwen3.5:4b',
    checkOllamaReady: async () => ({
      ok: false,
      error: 'Model qwen3.5:4b is not installed. Run: ollama pull qwen3.5:4b'
    }),
    clearInterval,
    importScripts: () => {},
    setInterval,
    setTimeout,
    chrome: {
      action: {
        onClicked: { addListener: () => {} },
        setBadgeBackgroundColor: () => {},
        setBadgeText: () => {},
        setIcon: () => {},
        setTitle: () => {}
      },
      tabGroups: {
        query: async () => [],
        update: async () => ({})
      },
      tabs: {
        group: async () => 1,
        move: async () => { moveCalls += 1; },
        query: async () => []
      },
      windows: {
        getAll: async () => [
          { id: 1, focused: true, incognito: false },
          { id: 2, focused: false, incognito: false }
        ]
      }
    }
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.error, 'Model qwen3.5:4b is not installed. Run: ollama pull qwen3.5:4b');
  assert.equal(moveCalls, 0);
});
