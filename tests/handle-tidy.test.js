const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

// background.js registers menu listeners at load and stores run state.
function withBackgroundDefaults(chrome) {
  if (!chrome) return chrome;
  return {
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    ...chrome,
    runtime: { onInstalled: { addListener: () => {} }, ...chrome.runtime },
    tabs: chrome.tabs && { query: async () => [], ...chrome.tabs }
  };
}

function loadScript(relativePath, globals = {}) {
  if (relativePath === 'background.js') globals = { ...globals, chrome: withBackgroundDefaults(globals.chrome) };
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

test('handleTidy reclassifies and replaces existing groups after classification succeeds', async () => {
  const events = [];
  let classifiedTabs;
  let ungroupedTabIds = [];
  let nextGroupId = 10;
  const browserTabs = [
    { id: 101, groupId: 7, url: 'https://github.com/acme/repo/pulls', title: 'Pull requests' },
    { id: 102, groupId: 8, url: 'https://jenkins.example/job/acme', title: 'Builds' }
  ];
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: async tabs => {
      events.push('classify');
      classifiedTabs = tabs;
      return {
        groups: [
          { name: 'Code Review', color: 'blue', tab_ids: [1] },
          { name: 'CI Builds', color: 'green', tab_ids: [2] }
        ]
      };
    },
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
          events.push('group');
          nextGroupId += 1;
          return nextGroupId;
        },
        move: async () => { events.push('move'); },
        query: async () => browserTabs,
        ungroup: async tabIds => {
          events.push('ungroup');
          ungroupedTabIds = [...tabIds];
        }
      },
      windows: {
        getAll: async () => [{ id: 1, focused: true, incognito: false }]
      }
    }
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(classifiedTabs.length, 2);
  assert.equal(JSON.stringify(ungroupedTabIds), JSON.stringify([101, 102]));
  assert.equal(events.indexOf('classify') < events.indexOf('ungroup'), true);
  assert.equal(events.indexOf('ungroup') < events.indexOf('group'), true);
  assert.equal(result.retidiedTabs, 2);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].tabs[0].title, 'Pull requests');
  assert.equal(result.groups[0].tabs[0].url, 'https://github.com/acme/repo/pulls');
});

test('handleTidy preserves windows and groups when classification fails', async () => {
  let moveCalls = 0;
  let ungroupCalls = 0;
  const context = loadScript('background.js', {
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: async () => { throw new Error('invalid model partition'); },
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
        query: async ({ windowId }) => [{
          id: windowId * 100,
          groupId: windowId,
          url: `https://window${windowId}.example/`,
          title: `Window ${windowId}`
        }],
        ungroup: async () => { ungroupCalls += 1; }
      },
      windows: {
        getAll: async () => [
          { id: 1, focused: true, incognito: false },
          { id: 2, focused: false, incognito: false }
        ]
      }
    }
  });

  await assert.rejects(vm.runInContext('handleTidy()', context), /invalid model partition/);
  assert.equal(moveCalls, 0);
  assert.equal(ungroupCalls, 0);
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
    status: 'warning',
    message: 'Tidied with a retry',
    groups: [{
      name: 'Code Review',
      color: 'blue',
      count: 1,
      tabs: [{ title: 'Pull request', url: 'https://github.com/acme/repo/pull/1' }]
    }],
    warnings: ['Model output needed repair'],
    details: [{
      title: 'Attempt 1',
      summary: 'Covered 8 of 10 tabs.',
      reasons: ['2 tab IDs were omitted.']
    }]
  };
  await vm.runInContext('publishReport(report)', context);

  assert.equal(storedReport.status, 'warning');
  assert.equal(storedReport.message, 'Tidied with a retry');
  assert.equal(storedReport.groups[0].tabs[0].url, 'https://github.com/acme/repo/pull/1');
  assert.equal(storedReport.details[0].title, 'Attempt 1');
  assert.equal(storedReport.details[0].reasons[0], '2 tab IDs were omitted.');
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
