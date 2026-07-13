const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function loadCodex(globals = {}) {
  const context = vm.createContext({ AbortSignal, URL, console, ...globals });
  for (const relativePath of ['lib/ollama.js', 'lib/codex.js']) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    vm.runInContext(source, context, { filename: relativePath });
  }
  return context;
}

function chromeWithResponse(response) {
  return {
    runtime: {
      lastError: null,
      sendNativeMessage: (_host, _message, callback) => callback(response)
    }
  };
}

test('checkCodexReady accepts the installed native host', async () => {
  const context = loadCodex({ chrome: chromeWithResponse({ ok: true, model: 'gpt-5.4-mini' }) });
  const result = await vm.runInContext('checkCodexReady()', context);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.4-mini');
});

test('checkCodexReady reports host installation guidance', async () => {
  const chrome = chromeWithResponse(null);
  chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
  const context = loadCodex({ chrome });
  const result = await vm.runInContext('checkCodexReady()', context);
  assert.equal(result.ok, false);
  assert.match(result.error, /install-host\.sh/);
});

test('classifyTabsCodex sends one request and separates browser errors', async () => {
  let request;
  const chrome = {
    runtime: {
      lastError: null,
      sendNativeMessage: (_host, message, callback) => {
        request = message;
        callback({
          ok: true,
          groups: [{ name: 'Release Work', color: 'blue', tab_ids: [1, 2] }]
        });
      }
    }
  };
  const context = loadCodex({ chrome });
  context.tabs = [
    { title: 'Privacy error', url: 'https://example.invalid' },
    { title: 'GitHub pull request', url: 'https://github.com/acme/repo/pull/1' },
    { title: 'Jenkins build', url: 'https://jenkins.example/job/1' }
  ];

  const result = await vm.runInContext('classifyTabsCodex(tabs)', context);
  assert.equal(request.action, 'classify');
  assert.equal(request.tabs.length, 2);
  assert.equal(result.groups.find(group => group.name === 'Errors').tab_ids[0], 1);
  assert.equal(
    JSON.stringify(result.groups.find(group => group.name === 'Release Work').tab_ids),
    JSON.stringify([2, 3])
  );
});

test('classifyTabsCodex repairs incomplete output without a huge catch-all group', async () => {
  const context = loadCodex({
    chrome: chromeWithResponse({
      ok: true,
      groups: [{ name: 'Work', color: 'blue', tab_ids: [1, 2] }]
    })
  });
  context.tabs = Array.from({ length: 8 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/`
  }));

  const result = await vm.runInContext('classifyTabsCodex(tabs)', context);
  assert.equal(JSON.stringify(result.groups.flatMap(group => group.tab_ids).sort((a, b) => a - b)), JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(Math.max(...result.groups.map(group => group.tab_ids.length)) <= 5, true);
  assert.match(result.warnings[0], /needed repair/i);
});
