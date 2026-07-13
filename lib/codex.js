const CODEX_HOST_NAME = 'com.ohade.tidy_tabs';
const CODEX_MODEL = 'gpt-5.6-luna';
const MAX_CODEX_CLASSIFICATION_ATTEMPTS = 2;
const MAX_CODEX_PLAN_ATTEMPTS = 2;
const CODEX_BATCH_SIZE = 50;
const CODEX_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

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

function serializeCodexTabs(tabs) {
  return tabs.map((entry, index) => ({
    id: index + 1,
    title: entry.tab.title || 'Untitled',
    url: entry.tab.url || ''
  }));
}

function normalizeCategoryPlan(rawCategories) {
  const issues = {
    malformedResponse: Array.isArray(rawCategories) ? 0 : 1,
    malformedCategories: 0,
    invalidColors: 0,
    emptyNames: 0,
    emptyDescriptions: 0,
    vagueNames: 0,
    duplicateNames: 0
  };
  if (!Array.isArray(rawCategories)) return { valid: false, categories: [], issues };

  const categories = [];
  const names = new Set();
  for (const rawCategory of rawCategories) {
    if (!rawCategory || typeof rawCategory.name !== 'string') {
      issues.malformedCategories += 1;
      continue;
    }
    const name = rawCategory.name.trim();
    const description = typeof rawCategory.description === 'string'
      ? rawCategory.description.trim()
      : '';
    const key = name.toLowerCase();
    if (!name) issues.emptyNames += 1;
    if (!description) issues.emptyDescriptions += 1;
    if (name && VAGUE_GROUP_NAME_PATTERN.test(name)) issues.vagueNames += 1;
    if (name && names.has(key)) issues.duplicateNames += 1;
    if (!CODEX_COLORS.includes(rawCategory.color)) issues.invalidColors += 1;
    if (!name || !description || names.has(key) || !CODEX_COLORS.includes(rawCategory.color)) continue;
    names.add(key);
    categories.push({ name, description, color: rawCategory.color });
  }

  const issueCount = Object.values(issues).reduce((sum, count) => sum + count, 0);
  return {
    valid: issueCount === 0 && categories.length >= 2 && categories.length <= 30,
    categories,
    issues
  };
}

function describeCategoryPlanFailure(normalized, attempt) {
  const reasons = [];
  const issues = normalized.issues || {};
  if (issues.malformedResponse) reasons.push('The response did not contain a categories array.');
  if (issues.malformedCategories) reasons.push(`${issues.malformedCategories} categor${issues.malformedCategories === 1 ? 'y had' : 'ies had'} an invalid structure.`);
  if (issues.invalidColors) reasons.push(`${issues.invalidColors} categor${issues.invalidColors === 1 ? 'y used' : 'ies used'} an invalid color.`);
  if (issues.emptyNames) reasons.push(`${issues.emptyNames} categor${issues.emptyNames === 1 ? 'y had' : 'ies had'} no name.`);
  if (issues.emptyDescriptions) reasons.push(`${issues.emptyDescriptions} categor${issues.emptyDescriptions === 1 ? 'y had' : 'ies had'} no intent description.`);
  if (issues.vagueNames) reasons.push(`${issues.vagueNames} categor${issues.vagueNames === 1 ? 'y used' : 'ies used'} a disallowed vague name.`);
  if (issues.duplicateNames) reasons.push(`${issues.duplicateNames} duplicate category name${issues.duplicateNames === 1 ? ' was' : 's were'} returned.`);
  if (normalized.categories.length < 2) reasons.push('Fewer than 2 usable categories were returned.');
  if (normalized.categories.length > 30) reasons.push('More than 30 categories were returned.');
  return {
    title: `Category plan · Attempt ${attempt}`,
    summary: `Codex returned ${normalized.categories.length} usable categor${normalized.categories.length === 1 ? 'y' : 'ies'}.`,
    reasons
  };
}

async function requestCodexCategoryPlan(tabs) {
  const failedAttempts = [];
  for (let attempt = 1; attempt <= MAX_CODEX_PLAN_ATTEMPTS; attempt++) {
    const response = await sendCodexNativeMessage({
      action: 'plan',
      strict_retry: attempt > 1,
      tabs: serializeCodexTabs(tabs)
    });
    if (!response.ok) throw new Error(response.error || 'Codex category planning failed');
    const normalized = normalizeCategoryPlan(response.categories);
    if (normalized.valid) return { categories: normalized.categories, retried: attempt > 1 };
    failedAttempts.push(describeCategoryPlanFailure(normalized, attempt));
  }

  const error = new Error('Codex could not produce a valid category plan; no tab groups were changed.');
  error.details = failedAttempts;
  throw error;
}

function normalizeGroupsWithPlan(rawGroups, expectedTabCount, allowedCategories) {
  const normalized = normalizeExactGroups(rawGroups, expectedTabCount);
  if (!allowedCategories) return normalized;

  const categoriesByName = new Map(
    allowedCategories.map(category => [category.name.toLowerCase(), category])
  );
  let unknownCategories = 0;
  normalized.groups = normalized.groups.map(group => {
    const category = categoriesByName.get(group.name.toLowerCase());
    if (!category) {
      unknownCategories += 1;
      return group;
    }
    return { ...group, name: category.name, color: category.color };
  });
  normalized.issues.unknownCategories = unknownCategories;
  normalized.valid = normalized.valid && unknownCategories === 0;
  return normalized;
}

async function requestCodexGroups(tabs, strictRetry = false, allowedCategories = null) {
  const response = await sendCodexNativeMessage({
    action: 'classify',
    strict_retry: strictRetry,
    allowed_categories: allowedCategories,
    tabs: serializeCodexTabs(tabs)
  });
  if (!response.ok) throw new Error(response.error || 'Codex classification failed');
  return normalizeGroupsWithPlan(response.groups, tabs.length, allowedCategories);
}

function describeCodexPartitionFailure(normalized, attempt, scope = '') {
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
  if (issues.unknownCategories) reasons.push(`${issues.unknownCategories} group${issues.unknownCategories === 1 ? ' used' : 's used'} a name outside the shared category plan.`);
  if (reasons.length === 0) reasons.push(`${normalized.invalidCount || 1} invalid grouping rule${normalized.invalidCount === 1 ? ' was' : 's were'} detected.`);

  return {
    title: scope ? `${scope} · Attempt ${attempt}` : `Attempt ${attempt}`,
    summary: `Codex returned ${returnedGroups} group${returnedGroups === 1 ? '' : 's'} covering ${issues.coveredIds || 0} of ${issues.expectedIds || 0} model-classified tabs.`,
    reasons
  };
}

async function classifyCodexBatch(tabs, allowedCategories = null, scope = '') {
  let normalized;
  const failedAttempts = [];
  for (let attempt = 1; attempt <= MAX_CODEX_CLASSIFICATION_ATTEMPTS; attempt++) {
    normalized = await requestCodexGroups(tabs, attempt > 1, allowedCategories);
    if (normalized.valid) return { groups: normalized.groups, retried: attempt > 1 };
    console.warn(
      `[codex] ${scope || 'Classification'} attempt ${attempt} returned an invalid partition; ` +
      `missing=${normalized.missing.length}, invalid=${normalized.invalidCount}`
    );
    failedAttempts.push(describeCodexPartitionFailure(normalized, attempt, scope));
  }

  const error = new Error(
    `Codex could not produce a complete grouping${scope ? ` for ${scope.toLowerCase()}` : ''} ` +
    `after ${MAX_CODEX_CLASSIFICATION_ATTEMPTS} attempts; no tab groups were changed.`
  );
  error.details = failedAttempts;
  throw error;
}

async function classifyTabsCodex(tabs) {
  const indexedTabs = tabs.map((tab, index) => ({ tab, globalId: index + 1 }));
  const errorTabs = indexedTabs.filter(entry => isErrorTab(entry.tab));
  const tabsToClassify = indexedTabs.filter(entry => !isErrorTab(entry.tab));
  const warnings = [];
  let groups = [];

  if (tabsToClassify.length > 0) {
    if (tabsToClassify.length <= CODEX_BATCH_SIZE) {
      const classified = await classifyCodexBatch(tabsToClassify);
      if (classified.retried) warnings.push('Codex returned an incomplete first result; a strict retry succeeded.');
      groups = classified.groups.map(group => ({
        ...group,
        tab_ids: group.tab_ids.map(id => tabsToClassify[id - 1].globalId)
      }));
    } else {
      const planned = await requestCodexCategoryPlan(tabsToClassify);
      if (planned.retried) warnings.push('The shared category plan required a strict retry.');
      const categoryBuckets = new Map(
        planned.categories.map(category => [
          category.name.toLowerCase(),
          { ...category, tab_ids: [] }
        ])
      );
      const batchCount = Math.ceil(tabsToClassify.length / CODEX_BATCH_SIZE);

      for (let offset = 0, batchNumber = 1; offset < tabsToClassify.length; offset += CODEX_BATCH_SIZE, batchNumber++) {
        const batch = tabsToClassify.slice(offset, offset + CODEX_BATCH_SIZE);
        const classified = await classifyCodexBatch(batch, planned.categories, `Batch ${batchNumber} of ${batchCount}`);
        if (classified.retried) warnings.push(`Batch ${batchNumber} required a strict retry.`);
        for (const group of classified.groups) {
          const bucket = categoryBuckets.get(group.name.toLowerCase());
          bucket.tab_ids.push(...group.tab_ids.map(id => batch[id - 1].globalId));
        }
      }

      groups = planned.categories
        .map(category => categoryBuckets.get(category.name.toLowerCase()))
        .filter(bucket => bucket.tab_ids.length > 0);
    }
  }

  for (let i = 0; i < errorTabs.length; i += MAX_TABS_PER_GROUP) {
    const chunkNumber = Math.floor(i / MAX_TABS_PER_GROUP) + 1;
    groups.push({
      name: chunkNumber === 1 ? 'Errors' : `Errors ${chunkNumber}`,
      color: 'red',
      tab_ids: errorTabs.slice(i, i + MAX_TABS_PER_GROUP).map(entry => entry.globalId)
    });
  }

  // Model responses stay capped at 15 tabs for reliable exact assignment.
  // Deterministically merged taxonomy categories may be larger in Chrome.
  const finalGroups = normalizeExactGroups(groups, tabs.length, Number.POSITIVE_INFINITY);
  if (!finalGroups.valid) {
    throw new Error(`Final Codex grouping lost coverage for ${finalGroups.missing.length} of ${tabs.length} tabs`);
  }
  return { groups: finalGroups.groups, warnings: [...new Set(warnings)] };
}
