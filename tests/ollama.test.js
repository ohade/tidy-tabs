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

test('handleTidy checks Codex before moving tabs', async () => {
  let moveCalls = 0;
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({
      ok: false,
      error: 'Codex host is not ready'
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
  assert.equal(result.error, 'Codex host is not ready');
  assert.equal(moveCalls, 0);
});

function ollamaResponse(groups) {
  return {
    ok: true,
    json: async () => ({
      message: { content: JSON.stringify({ groups }) },
      total_duration: 1e9,
      eval_count: 1
    })
  };
}

test('classifyTabs retries an incomplete batch instead of creating Other', async () => {
  let fetchCalls = 0;
  const context = loadScript('lib/ollama.js', {
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return ollamaResponse([{ name: 'Work', color: 'blue', tab_ids: [1, 2] }]);
      }
      return ollamaResponse([
        { name: 'Work', color: 'blue', tab_ids: [1, 2] },
        { name: 'Reading', color: 'green', tab_ids: [3, 4] }
      ]);
    }
  });
  context.tabs = Array.from({ length: 4 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(fetchCalls, 2);
  assert.equal(result.groups.some(group => group.name === 'Other'), false);
  assert.equal(
    JSON.stringify([...result.groups.flatMap(group => group.tab_ids)].sort((a, b) => a - b)),
    JSON.stringify([1, 2, 3, 4])
  );
});

test('classifyTabs repairs repeatedly incomplete batch output with bounded review groups', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ollamaResponse([{ name: 'Work', color: 'blue', tab_ids: [1, 2] }])
  });
  context.tabs = Array.from({ length: 4 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(JSON.stringify(result.groups.flatMap(group => group.tab_ids).sort((a, b) => a - b)), JSON.stringify([1, 2, 3, 4]));
  assert.equal(result.groups.some(group => group.name === 'Needs Review'), true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /2 tabs could not be classified reliably/i);
});

test('classifyTabs repairs repeated vague catch-all names', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ollamaResponse([{
      name: 'Other Tabs',
      color: 'grey',
      tab_ids: [1, 2, 3, 4]
    }])
  });
  context.tabs = Array.from({ length: 4 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(JSON.stringify(result.groups.map(group => group.name)), JSON.stringify(['Needs Review']));
  assert.equal(JSON.stringify(result.groups[0].tab_ids), JSON.stringify([1, 2, 3, 4]));
  assert.equal(result.warnings.length, 1);
});

test('classifyTabs repairs repeated empty-name groups without losing IDs', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ollamaResponse([{
      name: '',
      color: 'grey',
      tab_ids: [1, 2, 3, 4]
    }])
  });
  context.tabs = Array.from({ length: 4 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(JSON.stringify(result.groups.map(group => group.name)), JSON.stringify(['Needs Review']));
  assert.equal(JSON.stringify(result.groups[0].tab_ids), JSON.stringify([1, 2, 3, 4]));
});

test('classifyTabs rejects incomplete consolidation maps', async () => {
  let fetchCalls = 0;
  const context = loadScript('lib/ollama.js', {
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls <= 13) {
        const batchSize = vm.runInContext('BATCH_SIZE', context);
        return ollamaResponse([{
          name: `Topic ${fetchCalls}`,
          color: 'blue',
          tab_ids: Array.from({ length: batchSize }, (_, index) => index + 1)
        }]);
      }
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              CombinedA: [1],
              CombinedB: [2],
              CombinedC: [3]
            })
          }
        })
      };
    }
  });
  const batchSize = vm.runInContext('BATCH_SIZE', context);
  context.tabs = Array.from({ length: batchSize * 13 }, (_, index) => ({
    title: `Tab ${index + 1}`,
    url: `https://site${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(fetchCalls, 14);
  assert.equal(result.groups.some(group => group.name === 'Other'), false);
  assert.equal(result.groups.length, 13);
  assert.equal(
    JSON.stringify([...result.groups.flatMap(group => group.tab_ids)].sort((a, b) => a - b)),
    JSON.stringify(context.tabs.map((_, index) => index + 1))
  );
});

test('classifyTabs keeps browser error pages out of model-generated topics', async () => {
  let sentBody;
  const context = loadScript('lib/ollama.js', {
    fetch: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return ollamaResponse([{ name: 'Work', color: 'blue', tab_ids: [1, 2] }]);
    }
  });
  context.tabs = [
    { title: 'Privacy error', url: 'https://yandex.com/search' },
    { title: '404 Not Found', url: 'https://example.com/missing' },
    { title: 'GitHub Pull Requests', url: 'https://github.com/pulls' },
    { title: 'Jenkins Build Dashboard', url: 'https://jenkins.io/builds' }
  ];

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  const errors = result.groups.find(group => group.name === 'Errors');
  const work = result.groups.find(group => group.name === 'Work');
  assert.equal(JSON.stringify(errors.tab_ids), JSON.stringify([1, 2]));
  assert.equal(JSON.stringify(work.tab_ids), JSON.stringify([3, 4]));
  assert.match(sentBody.messages[1].content, /Group these 2 tabs/);
  assert.doesNotMatch(sentBody.messages[1].content, /Privacy error|404 Not Found/);
});

test('exact partition validators reject duplicate and out-of-range IDs', () => {
  const context = loadScript('lib/ollama.js', { fetch: async () => {} });

  assert.equal(vm.runInContext(`normalizeExactGroups([
    { name: 'A', color: 'blue', tab_ids: [1, 2] },
    { name: 'B', color: 'green', tab_ids: [2, 3] }
  ], 3).valid`, context), false);
  assert.equal(vm.runInContext(`normalizeExactGroups([
    { name: 'A', color: 'blue', tab_ids: [1, 2, 4] },
    { name: 'B', color: 'green', tab_ids: [3] }
  ], 3).valid`, context), false);
  context.sourceGroups = Array.from({ length: 13 }, (_, index) => ({
    name: `Source ${index + 1}`,
    color: 'blue',
    tab_ids: [index + 1]
  }));
  assert.equal(vm.runInContext(`isExactMergePartition({
    A: [1, 2], B: [3, 4], C: [5, 6], D: [7, 8], E: [9, 10], F: [10, 11, 12, 13]
  }, sourceGroups)`, context), false);
  assert.equal(vm.runInContext(`isExactMergePartition({
    A: [1, 2], B: [3, 4], C: [5, 6], D: [7, 8], E: [9, 10], F: [11, 12, 14]
  }, sourceGroups)`, context), false);
  assert.equal(vm.runInContext(`normalizeExactGroups([
    { name: 'Other', color: 'grey', tab_ids: [1, 2, 3] }
  ], 3).valid`, context), false);
  assert.equal(vm.runInContext(`normalizeExactGroups([
    { name: 'Other Tabs', color: 'grey', tab_ids: [1, 2, 3] }
  ], 3).valid`, context), false);
  assert.equal(vm.runInContext(`normalizeExactGroups([
    { name: 'General Web', color: 'grey', tab_ids: [1, 2, 3] }
  ], 3).valid`, context), false);
  assert.equal(vm.runInContext(`isExactMergePartition({
    Other: [1, 2, 3], B: [4, 5], C: [6, 7], D: [8, 9], E: [10, 11], F: [12, 13]
  }, sourceGroups)`, context), false);
});

test('classifyTabs caps same-name groups across batches', async () => {
  const context = loadScript('lib/ollama.js', {
    fetch: async () => ollamaResponse([{
      name: 'Research',
      color: 'blue',
      tab_ids: Array.from({ length: 15 }, (_, index) => index + 1)
    }])
  });
  context.tabs = Array.from({ length: 30 }, (_, index) => ({
    title: `Research ${index + 1}`,
    url: `https://research${index + 1}.example/path`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(result.groups.length, 2);
  assert.equal(Math.max(...result.groups.map(group => group.tab_ids.length)), 15);
  assert.equal(result.groups.some(group => group.name === 'Other'), false);
});

test('handleTidy rolls back and reports group application failures', async () => {
  let groupCalls = 0;
  let rolledBack = [];
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: async () => ({
      groups: [
        { name: 'One', color: 'blue', tab_ids: [1] },
        { name: 'Two', color: 'green', tab_ids: [2] }
      ]
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
        update: async groupId => ({ id: groupId, title: 'ok', color: 'blue', collapsed: false })
      },
      tabs: {
        group: async () => {
          groupCalls += 1;
          if (groupCalls === 2) throw new Error('group failed');
          return 10;
        },
        move: async () => {},
        query: async () => [
          { id: 101, groupId: -1, url: 'https://one.example', title: 'One' },
          { id: 102, groupId: -1, url: 'https://two.example', title: 'Two' }
        ],
        ungroup: async tabIds => { rolledBack = [...tabIds]; }
      },
      windows: {
        getAll: async () => [{ id: 1, focused: true, incognito: false }]
      }
    }
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.match(result.error, /Failed to apply group "Two": group failed/);
  assert.equal(JSON.stringify(rolledBack), JSON.stringify([101]));
  assert.equal(result.groups.length, 0);
  assert.match(result.warnings[0], /Rolled back 1 tab/);
});

test('classifyTabs chunks large deterministic error groups', async () => {
  let fetchCalls = 0;
  const context = loadScript('lib/ollama.js', {
    fetch: async () => { fetchCalls += 1; }
  });
  context.tabs = Array.from({ length: 16 }, (_, index) => ({
    title: `Privacy error ${index + 1}`,
    url: `https://error${index + 1}.example/`
  }));

  const result = await vm.runInContext('classifyTabs(tabs, DEFAULT_MODEL)', context);
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(result.groups.map(group => group.name)), JSON.stringify(['Errors', 'Errors 2']));
  assert.equal(JSON.stringify(result.groups.map(group => group.tab_ids.length)), JSON.stringify([15, 1]));
});

test('publishReport persists details and opens a visible report tab', async () => {
  let storedReport;
  let openedUrl;
  const context = loadScript('background.js', {
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
      runtime: { getURL: path => `chrome-extension://tidy/${path}` },
      storage: { local: { set: async value => { storedReport = value.lastTidyReport; } } },
      tabs: { create: async ({ url }) => { openedUrl = url; } }
    }
  });

  context.report = {
    status: 'error',
    message: 'Could not classify tabs',
    groups: [],
    warnings: ['Model output needed repair']
  };
  await vm.runInContext('publishReport(report)', context);

  assert.equal(storedReport.status, 'error');
  assert.equal(storedReport.message, 'Could not classify tabs');
  assert.match(storedReport.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(openedUrl, 'chrome-extension://tidy/report.html');
});

test('handleTidy reports collapse failures as warnings instead of failing the run', async () => {
  let updateCalls = 0;
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: async () => ({
      groups: [{ name: 'Work', color: 'blue', tab_ids: [1, 2] }],
      warnings: []
    }),
    clearInterval,
    importScripts: () => {},
    setInterval,
    setTimeout,
    chrome: {
      action: { onClicked: { addListener: () => {} }, setIcon: () => {} },
      tabGroups: {
        query: async () => [{ id: 10, title: 'Work' }],
        update: async () => {
          updateCalls += 1;
          if (updateCalls === 2) throw new Error('collapse failed');
          return { id: 10, title: 'Work', color: 'blue', collapsed: false };
        }
      },
      tabs: {
        group: async () => 10,
        move: async () => {},
        query: async () => [
          { id: 101, groupId: -1, url: 'https://one.example', title: 'One' },
          { id: 102, groupId: -1, url: 'https://two.example', title: 'Two' }
        ]
      },
      windows: { getAll: async () => [{ id: 1, focused: true, incognito: false }] }
    }
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.success, true);
  assert.equal(result.groups.length, 1);
  assert.match(result.warnings[0], /could not be collapsed: collapse failed/);
});

test('red-badge error paths persist and open a visible report', async () => {
  let clickListener;
  let badgeText;
  let storedReport;
  let reportOpened = false;
  loadScript('background.js', {
    clearInterval: () => {},
    importScripts: () => {},
    setInterval: () => 1,
    setTimeout: () => {},
    chrome: {
      action: {
        onClicked: { addListener: listener => { clickListener = listener; } },
        setBadgeBackgroundColor: () => {},
        setBadgeText: ({ text }) => { badgeText = text; },
        setIcon: () => {},
        setTitle: () => {}
      },
      runtime: { getURL: path => `chrome-extension://tidy/${path}` },
      storage: { local: { set: async value => { storedReport = value.lastTidyReport; } } },
      tabs: { create: async () => { reportOpened = true; } },
      windows: { getAll: async () => [] }
    }
  });

  await clickListener({});
  assert.equal(badgeText, '!');
  assert.equal(storedReport.status, 'error');
  assert.equal(storedReport.message, 'No browser window found');
  assert.equal(reportOpened, true);
});

test('handleTidy reports groups that may remain when rollback fails', async () => {
  let groupCalls = 0;
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: async () => ({
      groups: [
        { name: 'One', color: 'blue', tab_ids: [1] },
        { name: 'Two', color: 'green', tab_ids: [2] }
      ],
      warnings: []
    }),
    clearInterval,
    importScripts: () => {},
    setInterval,
    setTimeout,
    chrome: {
      action: { onClicked: { addListener: () => {} }, setIcon: () => {} },
      tabGroups: {
        query: async () => [],
        update: async groupId => ({ id: groupId, title: 'ok', color: 'blue', collapsed: false })
      },
      tabs: {
        group: async () => {
          groupCalls += 1;
          if (groupCalls === 2) throw new Error('group failed');
          return 10;
        },
        move: async () => {},
        query: async () => [
          { id: 101, groupId: -1, url: 'https://one.example', title: 'One' },
          { id: 102, groupId: -1, url: 'https://two.example', title: 'Two' }
        ],
        ungroup: async () => { throw new Error('rollback failed'); }
      },
      windows: { getAll: async () => [{ id: 1, focused: true, incognito: false }] }
    }
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, 'One');
  assert.match(result.warnings[0], /Rollback also failed: rollback failed/);
});
