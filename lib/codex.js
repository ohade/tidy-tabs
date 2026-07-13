const CODEX_HOST_NAME = 'com.ohade.tidy_tabs';
const CODEX_MODEL = 'gpt-5.6-luna';
const MAX_CODEX_CLASSIFICATION_ATTEMPTS = 2;

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
    return {
      ok: true,
      model: response.model || CODEX_MODEL,
      reasoningEffort: response.reasoning_effort || 'medium'
    };
  } catch (err) {
    return {
      ok: false,
      error: `${err.message}. Run native/install-host.sh, then reload Tidy Tabs in chrome://extensions.`
    };
  }
}

async function requestCodexGroups(tabs, strictRetry = false) {
  const response = await sendCodexNativeMessage({
    action: 'classify',
    strict_retry: strictRetry,
    tabs: tabs.map((entry, index) => ({
      id: index + 1,
      title: entry.tab.title || 'Untitled',
      url: entry.tab.url || ''
    }))
  });
  if (!response.ok) throw new Error(response.error || 'Codex classification failed');
  return normalizeExactGroups(response.groups, tabs.length);
}

function describeCodexPartitionFailure(normalized, attempt) {
  const issues = normalized.issues || {};
  const returnedGroups = issues.returnedGroups || 0;
  const reasons = [];
  if (issues.malformedResponse) reasons.push('The response did not contain a groups array.');
  if (issues.malformedGroups) reasons.push(`${issues.malformedGroups} group${issues.malformedGroups === 1 ? '' : 's'} had an invalid structure.`);
  if (issues.missingIds) reasons.push(`${issues.missingIds} tab ID${issues.missingIds === 1 ? ' was' : 's were'} omitted.`);
  if (issues.duplicateIds) reasons.push(`${issues.duplicateIds} tab ID${issues.duplicateIds === 1 ? ' was' : 's were'} assigned more than once.`);
  if (issues.invalidIds) reasons.push(`${issues.invalidIds} invented or out-of-range tab ID${issues.invalidIds === 1 ? ' was' : 's were'} returned.`);
  if (issues.oversizedGroups) reasons.push(`${issues.oversizedGroups} group${issues.oversizedGroups === 1 ? '' : 's'} exceeded the 15-tab limit.`);
  if (issues.emptyGroups) reasons.push(`${issues.emptyGroups} empty group${issues.emptyGroups === 1 ? ' was' : 's were'} returned.`);
  if (issues.emptyNames) reasons.push(`${issues.emptyNames} group${issues.emptyNames === 1 ? ' had' : 's had'} no name.`);
  if (issues.vagueNames) reasons.push(`${issues.vagueNames} group${issues.vagueNames === 1 ? ' used' : 's used'} a disallowed vague name.`);
  if (reasons.length === 0) reasons.push(`${normalized.invalidCount || 1} invalid grouping rule${normalized.invalidCount === 1 ? ' was' : 's were'} detected.`);

  return {
    title: `Attempt ${attempt}`,
    summary: `Codex returned ${returnedGroups} group${returnedGroups === 1 ? '' : 's'} covering ${issues.coveredIds || 0} of ${issues.expectedIds || 0} model-classified tabs.`,
    reasons
  };
}

async function classifyTabsCodex(tabs) {
  const indexedTabs = tabs.map((tab, index) => ({ tab, globalId: index + 1 }));
  const errorTabs = indexedTabs.filter(entry => isErrorTab(entry.tab));
  const tabsToClassify = indexedTabs.filter(entry => !isErrorTab(entry.tab));
  const warnings = [];
  let groups = [];

  if (tabsToClassify.length > 0) {
    let normalized;
    const failedAttempts = [];
    for (let attempt = 1; attempt <= MAX_CODEX_CLASSIFICATION_ATTEMPTS; attempt++) {
      normalized = await requestCodexGroups(tabsToClassify, attempt > 1);
      if (normalized.valid) {
        if (attempt > 1) warnings.push('Codex returned an incomplete first result; a strict retry succeeded.');
        break;
      }
      console.warn(
        `[codex] Attempt ${attempt} returned an invalid partition; ` +
        `missing=${normalized.missing.length}, invalid=${normalized.invalidCount}`
      );
      failedAttempts.push(describeCodexPartitionFailure(normalized, attempt));
    }

    if (!normalized.valid) {
      const error = new Error(
        `Codex could not produce a complete grouping after ${MAX_CODEX_CLASSIFICATION_ATTEMPTS} attempts; ` +
        'no tab groups were changed.'
      );
      error.details = failedAttempts;
      throw error;
    }

    groups = normalized.groups.map(group => ({
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
