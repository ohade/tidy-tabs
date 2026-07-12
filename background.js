importScripts('lib/ollama.js');

const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const FRAME_COUNT = 6;

let isRunning = false;
let animTimer = null;

async function publishReport(report) {
  const lastTidyReport = {
    status: report.status || 'error',
    message: report.message || '',
    groups: report.groups || [],
    warnings: report.warnings || [],
    timestamp: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastTidyReport });
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
}

async function tryPublishReport(report) {
  try {
    await publishReport(report);
  } catch (err) {
    console.error('[tidy] Could not open report:', err);
  }
}

// Click the toolbar icon → run tidy directly (no popup)
chrome.action.onClicked.addListener(async (tab) => {
  if (isRunning) return;
  isRunning = true;
  startIconAnimation();
  chrome.action.setTitle({ title: 'Tidying...' });

  try {
    const result = await handleTidy();
    if (result.error) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e04040' });
      chrome.action.setTitle({ title: `Tidy error: ${result.error}` });
      await tryPublishReport({
        status: 'error',
        message: result.error,
        groups: result.groups,
        warnings: result.warnings
      });
    } else {
      const count = result.groups.length;
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#40b040' });
      chrome.action.setTitle({ title: `Tidied into ${count} groups` });
      await tryPublishReport({
        status: result.warnings?.length ? 'warning' : 'success',
        message: `Tidied ${result.groups.reduce((sum, group) => sum + group.count, 0)} tabs into ${count} groups.`,
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
    await tryPublishReport({ status: 'error', message: err.message });
  } finally {
    stopIconAnimation();
    isRunning = false;
  }
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

async function handleTidy() {
  // Gather ALL non-incognito windows
  const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const normalWindows = allWindows.filter(w => !w.incognito);
  if (normalWindows.length === 0) return { error: 'No browser window found' };

  const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
  console.log('[tidy] Target window:', targetWindow.id, '| Total windows:', normalWindows.length);

  // Validate the local backend before moving any tabs between windows.
  const ollamaStatus = await checkOllamaReady(DEFAULT_MODEL);
  if (!ollamaStatus.ok) return { error: ollamaStatus.error };

  // Move tabs from other windows into the target window
  for (const win of normalWindows) {
    if (win.id === targetWindow.id) continue;
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const tabIds = tabs.map(t => t.id);
    if (tabIds.length > 0) {
      console.log(`[tidy] Merging ${tabIds.length} tabs from window ${win.id}`);
      await chrome.tabs.move(tabIds, { windowId: targetWindow.id, index: -1 });
    }
  }

  // Now query all tabs in the merged window
  const tabs = await chrome.tabs.query({ windowId: targetWindow.id });
  // Only classify ungrouped tabs — leave existing groups untouched
  const validTabs = tabs.filter(t =>
    t.groupId === -1 &&
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:')
  );
  console.log('[tidy] Tabs to classify:', validTabs.length);

  if (validTabs.length < 2) return { error: 'Need at least 2 ungrouped tabs' };

  // Classify
  console.log('[tidy] Classifying...');
  const classification = await classifyTabs(validTabs, DEFAULT_MODEL);
  console.log('[tidy] Result:', JSON.stringify(classification));

  // Create tab groups (collapsed)
  const results = [];
  const appliedTabIds = [];
  for (const group of classification.groups) {
    const tabIds = group.tab_ids
      .map(id => validTabs[id - 1]?.id)
      .filter(Boolean);

    if (tabIds.length === 0) continue;

    const color = CHROME_COLORS.includes(group.color) ? group.color : 'grey';
    let pendingGroup = null;
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: targetWindow.id } });
      appliedTabIds.push(...tabIds);
      pendingGroup = { name: group.name, color, count: tabIds.length, groupId };
      console.log(`[tidy] Created groupId=${groupId}, setting title="${group.name}" color="${color}"`);
      const updated = await chrome.tabGroups.update(groupId, { title: group.name, color });
      console.log(`[tidy] After update: id=${updated.id} title="${updated.title}" color="${updated.color}" collapsed=${updated.collapsed}`);
      results.push(pendingGroup);
      pendingGroup = null;
    } catch (err) {
      console.error(`[tidy] Group "${group.name}" failed:`, err);
      let rollbackWarning = '';
      let rollbackFailed = false;
      if (appliedTabIds.length > 0) {
        try {
          await chrome.tabs.ungroup(appliedTabIds);
          rollbackWarning = `Rolled back ${appliedTabIds.length} tab${appliedTabIds.length === 1 ? '' : 's'} after the application failure.`;
        } catch (rollbackErr) {
          console.error('[tidy] Rollback failed:', rollbackErr);
          rollbackFailed = true;
          rollbackWarning = `Rollback also failed: ${rollbackErr.message}`;
        }
      }
      const uncertainGroups = rollbackFailed
        ? [
            ...results,
            ...(pendingGroup ? [{ ...pendingGroup, name: `${pendingGroup.name} (state uncertain)` }] : [])
          ]
        : [];
      return {
        error: `Failed to apply group "${group.name}": ${err.message}`,
        groups: uncertainGroups,
        warnings: [...(classification.warnings || []), rollbackWarning].filter(Boolean)
      };
    }
  }

  // Collapse all groups
  const allGroupsNow = await chrome.tabGroups.query({ windowId: targetWindow.id });
  for (const g of allGroupsNow) {
    try {
      await chrome.tabGroups.update(g.id, { collapsed: true });
    } catch (err) {
      console.warn(`[tidy] Could not collapse group ${g.id}:`, err);
      classification.warnings = classification.warnings || [];
      classification.warnings.push(`Group "${g.title || g.id}" was created but could not be collapsed: ${err.message}`);
    }
  }

  console.log('[tidy] Done:', results.length, 'groups');
  return { success: true, groups: results, warnings: classification.warnings || [] };
}
