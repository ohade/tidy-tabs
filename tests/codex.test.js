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

test('classifyTabsCodex plans and merges exact batches for large tab sets', async () => {
  const requests = [];
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, message, callback) => {
          requests.push(message);
          if (message.action === 'plan') {
            callback({
              ok: true,
              categories: [
                { name: 'Development', description: 'Implementation and code changes.', color: 'blue' },
                { name: 'Reading', description: 'Reference material unrelated to active implementation.', color: 'green' }
              ]
            });
            return;
          }
          if (message.tabs.length === 50) {
            callback({
              ok: true,
              groups: [
                { name: 'Development', color: 'blue', tab_ids: Array.from({ length: 15 }, (_, index) => index + 1) },
                { name: 'Development', color: 'blue', tab_ids: Array.from({ length: 10 }, (_, index) => index + 16) },
                { name: 'Reading', color: 'green', tab_ids: Array.from({ length: 15 }, (_, index) => index + 26) },
                { name: 'Reading', color: 'green', tab_ids: Array.from({ length: 10 }, (_, index) => index + 41) }
              ]
            });
            return;
          }
          callback({
            ok: true,
            groups: [{ name: 'Development', color: 'blue', tab_ids: Array.from({ length: 11 }, (_, index) => index + 1) }]
          });
        }
      }
    }
  });
  context.tabs = Array.from({ length: 61 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/`
  }));

  const result = await vm.runInContext('classifyTabsCodex(tabs)', context);
  assert.equal(JSON.stringify(requests.map(request => request.action)), JSON.stringify(['plan', 'classify', 'classify']));
  assert.equal(requests[1].tabs.length, 50);
  assert.equal(requests[2].tabs.length, 11);
  assert.equal(JSON.stringify(requests[1].allowed_categories), JSON.stringify([
    { name: 'Development', description: 'Implementation and code changes.', color: 'blue' },
    { name: 'Reading', description: 'Reference material unrelated to active implementation.', color: 'green' }
  ]));
  assert.equal(JSON.stringify(result.groups.map(group => group.name)), JSON.stringify([
    'Development', 'Reading'
  ]));
  assert.equal(JSON.stringify(result.groups.map(group => group.tab_ids.length)), JSON.stringify([36, 25]));
  assert.equal(
    JSON.stringify(result.groups.flatMap(group => group.tab_ids).sort((a, b) => a - b)),
    JSON.stringify(Array.from({ length: 61 }, (_, index) => index + 1))
  );
});

test('classifyTabsCodex reports invalid shared category plans', async () => {
  let requests = 0;
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, message, callback) => {
          requests += 1;
          assert.equal(message.action, 'plan');
          callback({
            ok: true,
            categories: [{ name: 'Other', description: 'Everything else.', color: 'grey' }]
          });
        }
      }
    }
  });
  context.tabs = Array.from({ length: 51 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/`
  }));

  await assert.rejects(vm.runInContext('classifyTabsCodex(tabs)', context), error => {
    assert.match(error.message, /could not produce a valid category plan/i);
    assert.equal(error.details.length, 2);
    assert.equal(error.details[0].title, 'Category plan · Attempt 1');
    assert.equal(error.details[0].reasons.some(reason => /disallowed vague name/.test(reason)), true);
    return true;
  });
  assert.equal(requests, 2);
});

test('classifyTabsCodex classifies large-set batches in parallel', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, message, callback) => {
          if (message.action === 'plan') {
            callback({
              ok: true,
              categories: [
                { name: 'Development', description: 'Implementation work.', color: 'blue' },
                { name: 'Reading', description: 'Reference material.', color: 'green' }
              ]
            });
            return;
          }
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            const ids = message.tabs.map(tab => tab.id);
            callback({
              ok: true,
              groups: [
                { name: 'Development', color: 'blue', tab_ids: ids.slice(0, 15) },
                { name: 'Reading', color: 'green', tab_ids: ids.slice(15, 30) },
                { name: 'Development', color: 'blue', tab_ids: ids.slice(30, 45) },
                ...(ids.length > 45 ? [{ name: 'Reading', color: 'green', tab_ids: ids.slice(45) }] : [])
              ].filter(group => group.tab_ids.length > 0)
            });
          }, 5);
        }
      }
    },
    setTimeout
  });
  context.tabs = Array.from({ length: 120 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/`
  }));

  const result = await vm.runInContext('classifyTabsCodex(tabs)', context);
  assert.equal(maxInFlight, 3);
  assert.equal(
    JSON.stringify(result.groups.flatMap(group => group.tab_ids).sort((a, b) => a - b)),
    JSON.stringify(Array.from({ length: 120 }, (_, index) => index + 1))
  );
});

test('classifyTabsCodex adds tabs to existing groups and allows new ones', async () => {
  let request;
  const context = loadCodex({
    chrome: {
      runtime: {
        lastError: null,
        sendNativeMessage: (_host, message, callback) => {
          request = message;
          callback({
            ok: true,
            groups: [
              { name: 'release regression', color: 'blue', tab_ids: [1] },
              { name: 'Motorcycle Wiring', color: 'orange', tab_ids: [2] }
            ]
          });
        }
      }
    }
  });
  context.tabs = [
    { title: 'Release regression run 3', url: 'https://jenkins.example/release-regression/3' },
    { title: 'Motorcycle wiring diagram', url: 'https://moto.example/wiring' }
  ];
  context.existing = [{ name: 'Release Regression', description: 'Release regression suites.', color: 'green' }];

  const result = await vm.runInContext('classifyTabsCodex(tabs, { existingCategories: existing })', context);
  assert.equal(request.allow_new_categories, true);
  assert.equal(JSON.stringify(request.allowed_categories), JSON.stringify(context.existing));
  assert.equal(JSON.stringify(result.groups.map(group => [group.name, group.color])), JSON.stringify([
    ['Release Regression', 'green'], ['Motorcycle Wiring', 'orange']
  ]));
});

test('isErrorTab ignores pages that only mention an HTTP error', () => {
  const context = loadCodex();
  const isError = title => vm.runInContext(`isErrorTab(${JSON.stringify({ title })})`, context);
  assert.equal(isError('Fix error 500 in nginx - Stack Overflow'), false);
  assert.equal(isError('How to debug a 404 not found response in Express'), false);
  assert.equal(isError('Privacy error'), true);
  assert.equal(isError('404 Not Found'), true);
  assert.equal(isError('Error 404 (Not Found)!!1'), true);
  assert.equal(isError('Access Denied'), true);
});
