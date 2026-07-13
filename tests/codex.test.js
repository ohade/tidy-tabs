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
  const context = loadCodex({
    chrome: chromeWithResponse({
      ok: true,
      model: 'gpt-5.6-luna',
      reasoning_effort: 'medium'
    })
  });
  const result = await vm.runInContext('checkCodexReady()', context);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.reasoningEffort, 'medium');
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
  assert.equal(request.strict_retry, false);
  assert.equal(request.tabs.length, 2);
  assert.equal(result.groups.find(group => group.name === 'Errors').tab_ids[0], 1);
  assert.equal(
    JSON.stringify(result.groups.find(group => group.name === 'Release Work').tab_ids),
    JSON.stringify([2, 3])
  );
});

test('classifyTabsCodex retries incomplete output instead of creating review groups', async () => {
  const requests = [];
  const responses = [
    { ok: true, groups: [{ name: 'Work', color: 'blue', tab_ids: [1, 2] }] },
    {
      ok: true,
      groups: [
        { name: 'Work', color: 'blue', tab_ids: [1, 2, 3, 4] },
        { name: 'Reading', color: 'green', tab_ids: [5, 6, 7, 8] }
      ]
    }
  ];
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, message, callback) => {
          requests.push(message);
          callback(responses.shift());
        }
      }
    }
  });
  context.tabs = Array.from({ length: 8 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/`
  }));

  const result = await vm.runInContext('classifyTabsCodex(tabs)', context);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].strict_retry, false);
  assert.equal(requests[1].strict_retry, true);
  assert.equal(JSON.stringify(result.groups.flatMap(group => group.tab_ids).sort((a, b) => a - b)), JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(result.groups.some(group => group.name.startsWith('Needs Review')), false);
  assert.match(result.warnings[0], /strict retry succeeded/i);
});

test('classifyTabsCodex rejects repeatedly incomplete output', async () => {
  let requests = 0;
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, _message, callback) => {
          requests += 1;
          callback({ ok: true, groups: [{ name: 'Work', color: 'blue', tab_ids: [1] }] });
        }
      }
    }
  });
  context.tabs = [
    { title: 'One', url: 'https://one.example/' },
    { title: 'Two', url: 'https://two.example/' }
  ];

  await assert.rejects(vm.runInContext('classifyTabsCodex(tabs)', context), error => {
    assert.match(error.message, /could not produce a complete grouping after 2 attempts; no tab groups were changed/i);
    assert.equal(error.details.length, 2);
    assert.equal(error.details[0].title, 'Attempt 1');
    assert.equal(error.details[0].summary, 'Codex returned 1 group covering 1 of 2 model-classified tabs.');
    assert.match(error.details[0].reasons[0], /1 tab ID was omitted/);
    return true;
  });
  assert.equal(requests, 2);
});

test('Codex diagnostics identify each exact-partition rule failure', () => {
  const context = loadCodex({ chrome: chromeWithResponse({ ok: true }) });
  context.rawGroups = [
    { name: 'Other', color: 'grey', tab_ids: [1, 1, 5] },
    { name: '', color: 'blue', tab_ids: [2] },
    { name: 'Oversized', color: 'green', tab_ids: Array.from({ length: 16 }, () => 3) }
  ];

  const result = JSON.parse(vm.runInContext(
    'JSON.stringify(describeCodexPartitionFailure(normalizeExactGroups(rawGroups, 4), 1))',
    context
  ));
  assert.equal(result.summary, 'Codex returned 3 groups covering 1 of 4 model-classified tabs.');
  assert.equal(result.reasons.some(reason => /3 tab IDs were omitted/.test(reason)), true);
  assert.equal(result.reasons.some(reason => /assigned more than once/.test(reason)), true);
  assert.equal(result.reasons.some(reason => /out-of-range/.test(reason)), true);
  assert.equal(result.reasons.some(reason => /exceeded the 15-tab limit/.test(reason)), true);
  assert.equal(result.reasons.some(reason => /had no name/.test(reason)), true);
  assert.equal(result.reasons.some(reason => /disallowed vague name/.test(reason)), true);
});
