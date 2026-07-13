const CODEX_HOST_NAME = 'com.ohade.tidy_tabs';
const CODEX_MODEL = 'gpt-5.4-mini';

function sendCodexNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(CODEX_HOST_NAME, message, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(`Codex host unavailable: ${runtimeError.message}`));
        return;
      }
      if (!response) {
        reject(new Error('Codex host returned no response'));
        return;
      }
      resolve(response);
    });
  });
}

async function checkCodexReady() {
  try {
    const response = await sendCodexNativeMessage({ action: 'status' });
    if (!response.ok) return { ok: false, error: response.error || 'Codex host is not ready' };
    return { ok: true, model: response.model || CODEX_MODEL };
  } catch (err) {
    return {
      ok: false,
      error: `${err.message}. Run native/install-host.sh, then reload Tidy Tabs in chrome://extensions.`
    };
  }
}

function repairCodexGroups(rawGroups, expectedTabCount) {
  let normalized = normalizeExactGroups(rawGroups, expectedTabCount);
  if (normalized.valid) return { groups: normalized.groups, warnings: [] };

  const repairedGroups = [];
  let reviewGroupNumber = 1;
  for (const group of normalized.groups) {
    const name = VAGUE_GROUP_NAME_PATTERN.test(group.name)
      ? (reviewGroupNumber++ === 1 ? 'Needs Review' : `Needs Review ${reviewGroupNumber - 1}`)
      : group.name;
    repairedGroups.push({ ...group, name });
  }
  for (let i = 0; i < normalized.missing.length; i += FALLBACK_GROUP_SIZE) {
    const chunk = normalized.missing.slice(i, i + FALLBACK_GROUP_SIZE);
    const name = reviewGroupNumber++ === 1 ? 'Needs Review' : `Needs Review ${reviewGroupNumber - 1}`;
    repairedGroups.push({ name, color: 'grey', tab_ids: chunk });
  }

  normalized = normalizeExactGroups(repairedGroups, expectedTabCount);
  if (!normalized.valid) throw new Error('Codex returned an invalid tab partition that could not be repaired');
  return {
    groups: normalized.groups,
    warnings: ['Codex output needed repair; unresolved tabs were placed in bounded Needs Review groups.']
  };
}

async function classifyTabsCodex(tabs) {
  const indexedTabs = tabs.map((tab, index) => ({ tab, globalId: index + 1 }));
  const errorTabs = indexedTabs.filter(entry => isErrorTab(entry.tab));
  const tabsToClassify = indexedTabs.filter(entry => !isErrorTab(entry.tab));
  const warnings = [];
  let groups = [];

  if (tabsToClassify.length > 0) {
    const response = await sendCodexNativeMessage({
      action: 'classify',
      tabs: tabsToClassify.map((entry, index) => ({
        id: index + 1,
        title: entry.tab.title || 'Untitled',
        url: entry.tab.url || ''
      }))
    });
    if (!response.ok) throw new Error(response.error || 'Codex classification failed');

    const repaired = repairCodexGroups(response.groups, tabsToClassify.length);
    warnings.push(...repaired.warnings);
    groups = repaired.groups.map(group => ({
      ...group,
      tab_ids: group.tab_ids.map(id => tabsToClassify[id - 1].globalId)
    }));
  }

  for (let i = 0; i < errorTabs.length; i += MAX_TABS_PER_GROUP) {
    const chunkNumber = Math.floor(i / MAX_TABS_PER_GROUP) + 1;
    groups.push({
      name: chunkNumber === 1 ? 'Errors' : `Errors ${chunkNumber}`,
      color: 'red',
      tab_ids: errorTabs.slice(i, i + MAX_TABS_PER_GROUP).map(entry => entry.globalId)
    });
  }

  const finalGroups = normalizeExactGroups(groups, tabs.length);
  if (!finalGroups.valid) {
    throw new Error(`Final Codex grouping lost coverage for ${finalGroups.missing.length} of ${tabs.length} tabs`);
  }
  return { groups: finalGroups.groups, warnings: [...new Set(warnings)] };
}
