importScripts('lib/partition.js', 'lib/codex.js');

const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const FRAME_COUNT = 6;
const INCREMENTAL_MAX_TABS = 50;
const MAX_EXISTING_CATEGORIES = 60;
const MAX_STORED_CATEGORIES = 200;
const FULL_RETIDY_MENU_ID = 'tidy-full';
// The Claude extension owns these groups and re-creates one whenever its tab
// leaves, so touching them only produces more "Claude" groups.
const AGENT_GROUP_TITLE_PATTERN = /^(?:(?:⌛|🔔|✅)️?\s*)?Claude(?: \(MCP\))?$/u;
const ERROR_GROUP_TITLE_PATTERN = /^Errors(?: \d+)?$/;

let isRunning = false;
let animTimer = null;

async function publishReport(report) {
  const lastTidyReport = {
    status: report.status || 'error',
    message: report.message || '',
    groups: report.groups || [],
    warnings: report.warnings || [],
    details: report.details || [],
    timestamp: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastTidyReport });
  const url = chrome.runtime.getURL('report.html');
  const [openReport] = await chrome.tabs.query({ url });
  if (openReport) {
    await chrome.tabs.reload(openReport.id);
    await chrome.tabs.update(openReport.id, { active: true });
    await chrome.windows.update(openReport.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

async function tryPublishReport(report) {
  try {
    await publishReport(report);
  } catch (err) {
    console.error('[tidy] Could not open report:', err);
  }
}

async function runTidy(options = {}) {
  if (isRunning) return;
  isRunning = true;
  startIconAnimation();
  chrome.action.setTitle({ title: 'Tidying...' });

  try {
    const result = await handleTidy(options);
    if (result.error) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e04040' });
      chrome.action.setTitle({ title: `Tidy error: ${result.error}` });
      await tryPublishReport({
        status: 'error',
        message: result.error,
        groups: result.groups,
        warnings: result.warnings,
        details: result.details
      });
    } else {
      const count = result.groups.length;
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#40b040' });
      chrome.action.setTitle({ title: result.message });
      await tryPublishReport({
        status: result.warnings?.length ? 'warning' : 'success',
        message: result.message,
        groups: result.groups,
        warnings: result.warnings
      });
      // Clear badge after 5s
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: 'Tidy Tabs — click to organize' });
      }, 5000);
    }
  } catch (err) {
    console.error('[tidy] Error:', err);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e04040' });
    chrome.action.setTitle({ title: `Error: ${err.message}` });
    await tryPublishReport({ status: 'error', message: err.message, details: err.details });
  } finally {
    stopIconAnimation();
    isRunning = false;
  }
}

// Click the toolbar icon → tidy new tabs (no popup). Right-click → full re-tidy.
chrome.action.onClicked.addListener(() => runTidy());

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: FULL_RETIDY_MENU_ID, title: 'Re-tidy all tabs', contexts: ['action'] });
});

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === FULL_RETIDY_MENU_ID) return runTidy({ mode: 'full' });
});

function startIconAnimation() {
  let frame = 0;
  animTimer = setInterval(() => {
    chrome.action.setIcon({
      path: {
        '16': `icons/frame${frame}_16.png`,
        '48': `icons/frame${frame}_48.png`
      }
    });
    frame = (frame + 1) % FRAME_COUNT;
  }, 120);
}

function stopIconAnimation() {
  if (animTimer) clearInterval(animTimer);
  animTimer = null;
  chrome.action.setIcon({
    path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' }
  });
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

async function agentGroupIds() {
  const groups = await chrome.tabGroups.query({});
  return new Set(groups.filter(group => AGENT_GROUP_TITLE_PATTERN.test(group.title || '')).map(group => group.id));
}

function isEligibleTab(tab, agentGroups) {
  return Boolean(tab.url) &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://') &&
    !tab.url.startsWith('about:') &&
    !tab.pinned &&
    !agentGroups.has(tab.groupId);
}

// Existing named groups become the categories an incremental run may reuse.
async function existingGroupCategories(groups, tabs) {
  const { tidyCategories: stored = [] } = await chrome.storage.local.get('tidyCategories');
  const storedByName = new Map(stored.map(category => [category.name.toLowerCase(), category]));
  const groupsByName = new Map();
  const categories = [];
  for (const group of groups) {
    const name = (group.title || '').trim();
    const key = name.toLowerCase();
    if (!name || groupsByName.has(key)) continue;
    groupsByName.set(key, { id: group.id, name });
    if (ERROR_GROUP_TITLE_PATTERN.test(name) || categories.length >= MAX_EXISTING_CATEGORIES) continue;
    const exampleTitles = tabs
      .filter(tab => tab.groupId === group.id)
      .slice(0, 3)
      .map(tab => tab.title || tab.url);
    categories.push({
      name,
      description: storedByName.get(key)?.description ||
        `Existing tab group. Example tabs: ${exampleTitles.join('; ')}`,
      color: CHROME_COLORS.includes(group.color) ? group.color : 'grey'
    });
  }
  return { categories, groupsByName };
}

async function rememberCategories(groups, categories = []) {
  const { tidyCategories: previous = [] } = await chrome.storage.local.get('tidyCategories');
  const described = new Map(
    [...previous, ...categories]
      .filter(category => category.description)
      .map(category => [category.name.toLowerCase(), category.description])
  );
  const current = groups
    .filter(group => !ERROR_GROUP_TITLE_PATTERN.test(group.name))
    .map(group => ({ name: group.name, description: described.get(group.name.toLowerCase()) || '', color: group.color }));
  const currentNames = new Set(current.map(category => category.name.toLowerCase()));
  const tidyCategories = [
    ...current,
    ...previous.filter(category => !currentNames.has(category.name.toLowerCase()))
  ].slice(0, MAX_STORED_CATEGORIES);
  await chrome.storage.local.set({ tidyCategories });
}

async function handleTidy({ mode = 'auto' } = {}) {
  // Gather ALL non-incognito windows
  const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const normalWindows = allWindows.filter(w => !w.incognito);
  if (normalWindows.length === 0) return { error: 'No browser window found' };

  const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
  console.log('[tidy] Target window:', targetWindow.id, '| Total windows:', normalWindows.length);

  // Validate the Codex host before moving any tabs between windows.
  const providerStatus = await checkCodexReady();
  if (!providerStatus.ok) return { error: providerStatus.error };

  // Classify every eligible tab before mutating windows or existing groups.
  // Put the target window first so the classification order is predictable.
  const orderedWindows = [targetWindow, ...normalWindows.filter(win => win.id !== targetWindow.id)];
  const tabsByWindow = new Map();
  for (const win of orderedWindows) {
    tabsByWindow.set(win.id, await chrome.tabs.query({ windowId: win.id }));
  }
  const allTabs = orderedWindows.flatMap(win => tabsByWindow.get(win.id));
  const normalWindowIds = new Set(normalWindows.map(win => win.id));
  const windowGroups = (await chrome.tabGroups.query({})).filter(group => normalWindowIds.has(group.windowId));
  const agentGroups = new Set(
    windowGroups.filter(group => AGENT_GROUP_TITLE_PATTERN.test(group.title || '')).map(group => group.id)
  );
  const validTabs = allTabs.filter(tab => isEligibleTab(tab, agentGroups));
  console.log('[tidy] Eligible tabs:', validTabs.length);

  const warnings = [];
  let existing = { categories: [], groupsByName: new Map() };
  let tabsToClassify = validTabs;
  let runMode = 'full';
  if (mode === 'auto') {
    const nonAgentGroups = windowGroups.filter(group => !agentGroups.has(group.id));
    existing = await existingGroupCategories(nonAgentGroups, allTabs);
    const ungroupedTabs = validTabs.filter(tab => tab.groupId === -1);
    if (existing.groupsByName.size > 0) {
      if (ungroupedTabs.length === 0) {
        return {
          success: true,
          mode: 'incremental',
          groups: [],
          warnings: [],
          message: 'No new tabs to tidy; existing groups were left as they were.'
        };
      }
      if (ungroupedTabs.length <= INCREMENTAL_MAX_TABS) {
        runMode = 'incremental';
        tabsToClassify = ungroupedTabs;
      } else {
        warnings.push(
          `${ungroupedTabs.length} ungrouped tabs is more than ${INCREMENTAL_MAX_TABS}, so every tab was re-tidied.`
        );
      }
    }
  }
  if (runMode === 'full') existing = { categories: [], groupsByName: new Map() };

  if (runMode === 'full' && tabsToClassify.length < 2) return { error: 'Need at least 2 eligible tabs' };

  console.log(`[tidy] Classifying ${tabsToClassify.length} tabs (${runMode})...`);
  const classification = runMode === 'incremental'
    ? await classifyTabsCodex(tabsToClassify, { existingCategories: existing.categories })
    : await classifyTabsCodex(tabsToClassify);
  console.log('[tidy] Result:', JSON.stringify(classification));
  warnings.push(...(classification.warnings || []));

  // Classification can take minutes. Skip tabs the user closed, navigated,
  // or regrouped meanwhile so one stale ID cannot fail the whole run.
  const liveTabs = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab]));
  const isUnchanged = tab => {
    const live = liveTabs.get(tab.id);
    return Boolean(live) && live.url === tab.url && live.groupId === tab.groupId && !live.pinned;
  };
  const staleCount = tabsToClassify.filter(tab => !isUnchanged(tab)).length;
  if (staleCount > 0) {
    warnings.push(
      `${plural(staleCount, 'tab')} closed or changed during the run ${staleCount === 1 ? 'was' : 'were'} left as ${staleCount === 1 ? 'it was' : 'they were'}.`
    );
  }
  const eligibleTabIds = new Set(tabsToClassify.filter(isUnchanged).map(tab => tab.id));

  let previouslyGroupedTabIds = [];
  if (runMode === 'full') {
    // Move tabs from other windows into the target window, leaving agent tabs alone.
    const currentAgentGroups = await agentGroupIds();
    for (const win of normalWindows) {
      if (win.id === targetWindow.id) continue;
      const tabIds = (await chrome.tabs.query({ windowId: win.id }))
        .filter(tab => !currentAgentGroups.has(tab.groupId))
        .map(tab => tab.id);
      if (tabIds.length > 0) {
        console.log(`[tidy] Merging ${tabIds.length} tabs from window ${win.id}`);
        await chrome.tabs.move(tabIds, { windowId: targetWindow.id, index: -1 });
      }
    }

    // A successful classification makes this a full re-tidy: clear any old
    // eligible groups only now, immediately before applying the new grouping.
    const mergedTabs = await chrome.tabs.query({ windowId: targetWindow.id });
    previouslyGroupedTabIds = mergedTabs
      .filter(tab => eligibleTabIds.has(tab.id) && tab.groupId !== -1)
      .map(tab => tab.id);
    if (previouslyGroupedTabIds.length > 0) {
      console.log(`[tidy] Re-tidying ${previouslyGroupedTabIds.length} previously grouped tabs`);
      await chrome.tabs.ungroup(previouslyGroupedTabIds);
    }
  }

  // Create tab groups, or add to an existing group with the same name.
  const groupIdsByName = new Map([...existing.groupsByName].map(([key, group]) => [key, group.id]));
  const resultsByName = new Map();
  const appliedTabIds = [];
  for (const group of classification.groups) {
    const groupedTabs = group.tab_ids
      .map(id => tabsToClassify[id - 1])
      .filter(tab => tab && Number.isInteger(tab.id) && eligibleTabIds.has(tab.id));
    const tabIds = groupedTabs.map(tab => tab.id);

    if (tabIds.length === 0) continue;

    const key = group.name.toLowerCase();
    const name = existing.groupsByName.get(key)?.name || group.name;
    const color = CHROME_COLORS.includes(group.color) ? group.color : 'grey';
    let pendingGroup = null;
    try {
      let groupId = groupIdsByName.get(key);
      const isNewGroup = groupId === undefined;
      if (isNewGroup) {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: targetWindow.id } });
      } else {
        await chrome.tabs.group({ tabIds, groupId });
      }
      appliedTabIds.push(...tabIds);
      pendingGroup = {
        name,
        color,
        count: tabIds.length,
        groupId,
        tabs: groupedTabs.map(tab => ({
          title: tab.title || 'Untitled',
          url: tab.url || ''
        }))
      };
      if (isNewGroup) {
        console.log(`[tidy] Created groupId=${groupId}, setting title="${name}" color="${color}"`);
        const updated = await chrome.tabGroups.update(groupId, { title: name, color });
        console.log(`[tidy] After update: id=${updated.id} title="${updated.title}" color="${updated.color}" collapsed=${updated.collapsed}`);
        groupIdsByName.set(key, groupId);
      }
      const merged = resultsByName.get(key);
      if (merged) {
        merged.count += pendingGroup.count;
        merged.tabs.push(...pendingGroup.tabs);
      } else {
        resultsByName.set(key, pendingGroup);
      }
      pendingGroup = null;
    } catch (err) {
      console.error(`[tidy] Group "${name}" failed:`, err);
      let rollbackWarning = '';
      let rollbackFailed = false;
      if (appliedTabIds.length > 0) {
        try {
          await chrome.tabs.ungroup(appliedTabIds);
          rollbackWarning = `Rolled back ${plural(appliedTabIds.length, 'tab')} after the application failure.`;
        } catch (rollbackErr) {
          console.error('[tidy] Rollback failed:', rollbackErr);
          rollbackFailed = true;
          rollbackWarning = `Rollback also failed: ${rollbackErr.message}`;
        }
      }
      const uncertainGroups = rollbackFailed
        ? [
            ...resultsByName.values(),
            ...(pendingGroup ? [{ ...pendingGroup, name: `${pendingGroup.name} (state uncertain)` }] : [])
          ]
        : [];
      return {
        error: `Failed to apply group "${name}": ${err.message}`,
        groups: uncertainGroups,
        warnings: [...warnings, rollbackWarning].filter(Boolean)
      };
    }
  }
  const results = [...resultsByName.values()];

  // Collapse only the groups this run created or added to.
  for (const group of results) {
    try {
      await chrome.tabGroups.update(group.groupId, { collapsed: true });
    } catch (err) {
      console.warn(`[tidy] Could not collapse group ${group.groupId}:`, err);
      warnings.push(`Group "${group.name}" could not be collapsed: ${err.message}`);
    }
  }

  try {
    await rememberCategories(results, classification.categories);
  } catch (err) {
    console.warn('[tidy] Could not store categories:', err);
  }

  const tabCount = results.reduce((sum, group) => sum + group.count, 0);
  const newGroupCount = results.filter(group => !existing.groupsByName.has(group.name.toLowerCase())).length;
  const message = runMode === 'incremental'
    ? `Added ${plural(tabCount, 'new tab')} to ${plural(results.length, 'group')} (${newGroupCount} new).`
    : `Tidied ${plural(tabCount, 'tab')} into ${plural(results.length, 'group')}.`;
  console.log('[tidy] Done:', message);
  return {
    success: true,
    mode: runMode,
    message,
    groups: results,
    warnings: [...new Set(warnings)],
    retidiedTabs: previouslyGroupedTabIds.length
  };
}
