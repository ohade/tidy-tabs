const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const REPORT_URL = 'chrome-extension://tidy/report.html';

// A small stateful browser: tabs, windows, and groups behave the way the
// Chrome APIs Tidy Tabs uses do, including errors for tabs that are gone.
function createBrowser({ windows, tabs, groups = [], storage = {} }) {
  const state = {
    windows: windows.map(win => ({ incognito: false, focused: false, ...win })),
    tabs: tabs.map(tab => ({ groupId: -1, pinned: false, ...tab })),
    groups: new Map(groups.map(group => [group.id, { color: 'grey', collapsed: false, ...group }])),
    storage: JSON.parse(JSON.stringify(storage)),
    calls: [],
    menus: [],
    nextGroupId: 1000,
    nextTabId: 5000
  };

  const tabById = id => {
    const tab = state.tabs.find(candidate => candidate.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  };
  const pruneGroups = () => {
    for (const id of [...state.groups.keys()]) {
      if (!state.tabs.some(tab => tab.groupId === id)) state.groups.delete(id);
    }
  };
  const copy = value => ({ ...value });

  const chrome = {
    action: {
      onClicked: { addListener: listener => { state.clickListener = listener; } },
      setBadgeBackgroundColor: () => {},
      setBadgeText: () => {},
      setIcon: () => {},
      setTitle: () => {}
    },
    contextMenus: {
      create: item => { state.menus.push(item); },
      onClicked: { addListener: listener => { state.menuListener = listener; } }
    },
    runtime: {
      getURL: relativePath => `chrome-extension://tidy/${relativePath}`,
      onInstalled: { addListener: listener => { state.installedListener = listener; } }
    },
    storage: {
      local: {
        get: async key => (key in state.storage ? { [key]: state.storage[key] } : {}),
        set: async values => { Object.assign(state.storage, JSON.parse(JSON.stringify(values))); }
      }
    },
    windows: {
      getAll: async () => state.windows.map(copy),
      update: async (id, props) => { state.calls.push(['windows.update', id, props]); }
    },
    tabGroups: {
      query: async (query = {}) => [...state.groups.values()]
        .filter(group => query.windowId === undefined || group.windowId === query.windowId)
        .map(copy),
      update: async (id, props) => {
        const group = state.groups.get(id);
        if (!group) throw new Error(`No group with id: ${id}.`);
        Object.assign(group, props);
        state.calls.push(['tabGroups.update', id, props]);
        return copy(group);
      }
    },
    tabs: {
      query: async (query = {}) => state.tabs
        .filter(tab =>
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.groupId === undefined || tab.groupId === query.groupId) &&
          (query.url === undefined || tab.url === query.url))
        .map(copy),
      move: async (tabIds, { windowId }) => {
        const ids = [].concat(tabIds);
        ids.forEach(tabById);
        for (const id of ids) {
          const tab = tabById(id);
          if (tab.windowId !== windowId) {
            tab.windowId = windowId;
            tab.groupId = -1;
          }
        }
        pruneGroups();
        state.calls.push(['tabs.move', ids, windowId]);
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        tabIds.forEach(tabById);
        let target;
        if (groupId !== undefined) {
          target = state.groups.get(groupId);
          if (!target) throw new Error(`No group with id: ${groupId}.`);
        } else {
          target = {
            id: state.nextGroupId++,
            windowId: createProperties?.windowId ?? tabById(tabIds[0]).windowId,
            title: '',
            color: 'grey',
            collapsed: false
          };
          state.groups.set(target.id, target);
        }
        for (const id of tabIds) {
          const tab = tabById(id);
          tab.groupId = target.id;
          tab.windowId = target.windowId;
        }
        pruneGroups();
        state.calls.push(['tabs.group', [...tabIds], groupId]);
        return target.id;
      },
      ungroup: async tabIds => {
        const ids = [].concat(tabIds);
        ids.forEach(tabById);
        for (const id of ids) tabById(id).groupId = -1;
        pruneGroups();
        state.calls.push(['tabs.ungroup', ids]);
      },
      create: async ({ url }) => {
        const tab = { id: state.nextTabId++, windowId: state.windows[0].id, url, title: 'Report', groupId: -1 };
        state.tabs.push(tab);
        state.calls.push(['tabs.create', url]);
        return copy(tab);
      },
      update: async (id, props) => {
        state.calls.push(['tabs.update', id, props]);
        return copy(tabById(id));
      },
      reload: async id => {
        tabById(id);
        state.calls.push(['tabs.reload', id]);
      }
    }
  };

  const closeTab = id => {
    state.tabs = state.tabs.filter(tab => tab.id !== id);
    pruneGroups();
  };
  const tab = id => state.tabs.find(candidate => candidate.id === id);
  const groupOf = id => state.groups.get(tab(id)?.groupId);
  const callsNamed = name => state.calls.filter(call => call[0] === name);

  return { chrome, state, closeTab, tab, groupOf, callsNamed };
}

function loadBackground(browser, classifier) {
  const context = vm.createContext({
    URL,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    checkCodexReady: async () => ({ ok: true }),
    classifyTabsCodex: classifier,
    clearInterval,
    importScripts: () => {},
    setInterval,
    setTimeout,
    chrome: browser.chrome
  });
  const source = fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });
  return context;
}

// Puts every tab it receives into one group, recording what it was sent.
function recordingClassifier(name = 'Work', color = 'blue') {
  const calls = [];
  const classifier = async (tabs, options) => {
    calls.push({ tabs, options });
    return { groups: [{ name, color, tab_ids: tabs.map((_, index) => index + 1) }], warnings: [] };
  };
  return { classifier, calls };
}

test('tabs closed while the model runs are skipped instead of failing the run', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [
      { id: 101, windowId: 1, url: 'https://alpha.example/1', title: 'Alpha 1' },
      { id: 102, windowId: 1, url: 'https://alpha.example/2', title: 'Alpha 2' },
      { id: 201, windowId: 2, url: 'https://beta.example/1', title: 'Beta 1' },
      { id: 202, windowId: 2, url: 'https://beta.example/2', title: 'Beta 2' }
    ]
  });
  const context = loadBackground(browser, async () => {
    browser.closeTab(102);
    browser.closeTab(202);
    return {
      groups: [
        { name: 'Alpha', color: 'blue', tab_ids: [1, 2] },
        { name: 'Beta', color: 'green', tab_ids: [3, 4] }
      ],
      warnings: []
    };
  });

  const result = await vm.runInContext("handleTidy({ mode: 'full' })", context);
  assert.equal(result.success, true);
  assert.equal(browser.groupOf(101).title, 'Alpha');
  assert.equal(browser.groupOf(201).title, 'Beta');
  assert.equal(browser.tab(201).windowId, 1);
  assert.equal(JSON.stringify(result.groups.map(group => group.count)), JSON.stringify([1, 1]));
  assert.match(result.warnings.join('\n'), /2 tabs closed or changed during the run were left as they were/);
});

test('Claude agent groups are never classified, moved, regrouped, or collapsed', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 50, windowId: 2, title: '✅ Claude', color: 'orange' },
      { id: 51, windowId: 1, title: 'Claude (MCP)', color: 'yellow' },
      { id: 52, windowId: 1, title: '⌛ Claude', color: 'cyan' }
    ],
    tabs: [
      { id: 101, windowId: 1, url: 'https://one.example', title: 'One' },
      { id: 102, windowId: 1, groupId: 51, url: 'https://agent.example/mcp', title: 'Agent MCP tab' },
      { id: 103, windowId: 1, groupId: 52, url: 'https://agent.example/busy', title: 'Agent busy tab' },
      { id: 201, windowId: 2, groupId: 50, url: 'https://agent.example/done', title: 'Agent done tab' },
      { id: 202, windowId: 2, url: 'https://two.example', title: 'Two' }
    ]
  });
  const { classifier, calls } = recordingClassifier();
  const context = loadBackground(browser, classifier);

  const result = await vm.runInContext("handleTidy({ mode: 'full' })", context);
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(calls[0].tabs.map(tab => tab.id)), JSON.stringify([101, 202]));
  assert.equal(browser.tab(201).windowId, 2);
  assert.equal(browser.tab(201).groupId, 50);
  assert.equal(browser.tab(102).groupId, 51);
  assert.equal(browser.tab(103).groupId, 52);
  for (const id of [50, 51, 52]) assert.equal(browser.state.groups.get(id).collapsed, false);
});

test('pinned tabs stay out of tab groups', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 101, windowId: 1, pinned: true, url: 'https://mail.example', title: 'Inbox' },
      { id: 102, windowId: 1, url: 'https://one.example', title: 'One' },
      { id: 103, windowId: 1, url: 'https://two.example', title: 'Two' }
    ]
  });
  const { classifier, calls } = recordingClassifier();
  const context = loadBackground(browser, classifier);

  await vm.runInContext("handleTidy({ mode: 'full' })", context);
  assert.equal(JSON.stringify(calls[0].tabs.map(tab => tab.id)), JSON.stringify([102, 103]));
  assert.equal(browser.tab(101).groupId, -1);
});

test('publishReport reuses an open report tab instead of opening another', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    tabs: [{ id: 900, windowId: 2, url: REPORT_URL, title: 'Tidy Tabs Report' }]
  });
  const context = loadBackground(browser, async () => ({ groups: [] }));

  await vm.runInContext("publishReport({ status: 'success', message: 'ok' })", context);
  assert.equal(browser.callsNamed('tabs.create').length, 0);
  assert.equal(JSON.stringify(browser.callsNamed('tabs.reload')), JSON.stringify([['tabs.reload', 900]]));
  assert.equal(JSON.stringify(browser.callsNamed('tabs.update')), JSON.stringify([['tabs.update', 900, { active: true }]]));
  assert.equal(JSON.stringify(browser.callsNamed('windows.update')), JSON.stringify([['windows.update', 2, { focused: true }]]));
  assert.equal(browser.state.storage.lastTidyReport.message, 'ok');
});

test('publishReport opens a report tab when none is open', async () => {
  const browser = createBrowser({ windows: [{ id: 1, focused: true }], tabs: [] });
  const context = loadBackground(browser, async () => ({ groups: [] }));

  await vm.runInContext("publishReport({ status: 'success', message: 'ok' })", context);
  assert.equal(JSON.stringify(browser.callsNamed('tabs.create')), JSON.stringify([['tabs.create', REPORT_URL]]));
});

function existingGroupsBrowser(extraTabs = []) {
  return createBrowser({
    windows: [{ id: 1, focused: true }],
    storage: {
      tidyCategories: [
        { name: 'Release Regression', description: 'Release regression suites and failures.', color: 'green' }
      ]
    },
    groups: [
      { id: 5, windowId: 1, title: 'Release Regression', color: 'green', collapsed: true },
      { id: 6, windowId: 1, title: 'Search Cache Tuning', color: 'orange', collapsed: true },
      { id: 50, windowId: 1, title: '✅ Claude', color: 'orange' }
    ],
    tabs: [
      { id: 101, windowId: 1, groupId: 5, url: 'https://jenkins.example/release-regression/1', title: 'Release regression run 1' },
      { id: 102, windowId: 1, groupId: 5, url: 'https://jenkins.example/release-regression/2', title: 'Release regression run 2' },
      { id: 105, windowId: 1, groupId: 6, url: 'https://grafana.example/search-cache', title: 'Search cache dashboard' },
      { id: 150, windowId: 1, groupId: 50, url: 'https://agent.example/done', title: 'Agent done tab' },
      ...extraTabs
    ]
  });
}

test('a default click adds new tabs to existing groups without regrouping the rest', async () => {
  const browser = existingGroupsBrowser([
    { id: 103, windowId: 1, url: 'https://jenkins.example/release-regression/3', title: 'Release regression run 3' },
    { id: 104, windowId: 1, url: 'https://moto.example/wiring', title: 'Motorcycle wiring diagram' }
  ]);
  const calls = [];
  const context = loadBackground(browser, async (tabs, options) => {
    calls.push({ tabs, options });
    return {
      groups: [
        { name: 'Release Regression', color: 'green', tab_ids: [1] },
        { name: 'Motorcycle Wiring', color: 'purple', tab_ids: [2] }
      ],
      warnings: []
    };
  });

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.success, true);
  assert.equal(result.mode, 'incremental');
  assert.equal(JSON.stringify(calls[0].tabs.map(tab => tab.id)), JSON.stringify([103, 104]));
  const categories = calls[0].options.existingCategories;
  assert.equal(JSON.stringify(categories.map(category => category.name)), JSON.stringify(['Release Regression', 'Search Cache Tuning']));
  assert.equal(categories[0].description, 'Release regression suites and failures.');
  assert.match(categories[1].description, /Search cache dashboard/);
  assert.equal(browser.tab(103).groupId, 5);
  assert.equal(browser.groupOf(104).title, 'Motorcycle Wiring');
  assert.equal(browser.groupOf(104).color, 'purple');
  assert.equal(browser.tab(101).groupId, 5);
  assert.equal(browser.tab(105).groupId, 6);
  assert.equal(browser.tab(150).groupId, 50);
  assert.equal(browser.callsNamed('tabs.ungroup').length, 0);
  assert.equal(JSON.stringify(result.groups.map(group => [group.name, group.count])), JSON.stringify([
    ['Release Regression', 1], ['Motorcycle Wiring', 1]
  ]));
  const stored = browser.state.storage.tidyCategories.map(category => category.name);
  assert.equal(stored.includes('Motorcycle Wiring'), true);
  assert.equal(stored.includes('Release Regression'), true);
});

test('a default click with no ungrouped tabs does not call the model', async () => {
  const browser = existingGroupsBrowser();
  const { classifier, calls } = recordingClassifier();
  const context = loadBackground(browser, classifier);

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.success, true);
  assert.equal(calls.length, 0);
  assert.equal(result.groups.length, 0);
  assert.match(result.message, /No new tabs to tidy/);
  assert.equal(browser.callsNamed('tabs.ungroup').length, 0);
});

test('the Re-tidy all tabs menu item runs a full re-tidy', async () => {
  const browser = existingGroupsBrowser([
    { id: 103, windowId: 1, url: 'https://jenkins.example/release-regression/3', title: 'Release regression run 3' }
  ]);
  const { classifier, calls } = recordingClassifier();
  loadBackground(browser, classifier);

  browser.state.installedListener({ reason: 'install' });
  assert.equal(JSON.stringify(browser.state.menus), JSON.stringify([
    { id: 'tidy-full', title: 'Re-tidy all tabs', contexts: ['action'] }
  ]));
  await browser.state.menuListener({ menuItemId: 'tidy-full' });
  assert.equal(JSON.stringify(calls[0].tabs.map(tab => tab.id)), JSON.stringify([101, 102, 105, 103]));
  assert.equal(calls[0].options?.existingCategories, undefined);
  assert.equal(browser.tab(150).groupId, 50);
});

test('more than 50 ungrouped tabs falls back to a full re-tidy', async () => {
  const browser = existingGroupsBrowser(Array.from({ length: 51 }, (_, index) => ({
    id: 3000 + index,
    windowId: 1,
    url: `https://new${index}.example/`,
    title: `New ${index}`
  })));
  const { classifier, calls } = recordingClassifier();
  const context = loadBackground(browser, classifier);

  const result = await vm.runInContext('handleTidy()', context);
  assert.equal(result.mode, 'full');
  assert.equal(calls[0].tabs.length, 54);
  assert.equal(calls[0].options?.existingCategories, undefined);
  assert.match(result.warnings.join('\n'), /51 ungrouped tabs is more than 50, so every tab was re-tidied/);
});

test('a full re-tidy stores category descriptions for later incremental runs', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 101, windowId: 1, url: 'https://one.example', title: 'One' },
      { id: 102, windowId: 1, url: 'https://two.example', title: 'Two' }
    ]
  });
  const context = loadBackground(browser, async () => ({
    groups: [
      { name: 'Alpha', color: 'blue', tab_ids: [1] },
      { name: 'Beta', color: 'green', tab_ids: [2] }
    ],
    categories: [{ name: 'Alpha', description: 'Alpha project work.', color: 'blue' }],
    warnings: []
  }));

  await vm.runInContext("handleTidy({ mode: 'full' })", context);
  assert.equal(JSON.stringify(browser.state.storage.tidyCategories), JSON.stringify([
    { name: 'Alpha', description: 'Alpha project work.', color: 'blue' },
    { name: 'Beta', description: '', color: 'green' }
  ]));
});

test('repeated model groups with one name become one Chrome group', async () => {
  const browser = createBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 101, windowId: 1, url: 'https://one.example', title: 'One' },
      { id: 102, windowId: 1, url: 'https://two.example', title: 'Two' },
      { id: 103, windowId: 1, url: 'https://three.example', title: 'Three' }
    ]
  });
  const context = loadBackground(browser, async () => ({
    groups: [
      { name: 'Work', color: 'blue', tab_ids: [1, 2] },
      { name: 'Work', color: 'blue', tab_ids: [3] }
    ],
    warnings: []
  }));

  const result = await vm.runInContext("handleTidy({ mode: 'full' })", context);
  assert.equal(browser.state.groups.size, 1);
  assert.equal(JSON.stringify(result.groups.map(group => [group.name, group.count])), JSON.stringify([['Work', 3]]));
});
