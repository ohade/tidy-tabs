// Shared validation for model groupings: every tab exactly once, no vague names.
const MAX_TABS_PER_GROUP = 15;
const ERROR_TITLE_PATTERN = /^\s*(?:privacy error|your connection is not private|page not found|404 not found|(?:this )?site can(?:not|'t|’t) be reached|server not found|access denied|error \d{3})/i;
const VAGUE_GROUP_NAME_PATTERN = /^(?:(?:other|misc(?:ellaneous)?|general|uncategorized|various)(?:\s+(?:tabs?|sites?|pages?|web|stuff|items?|content))?|news\s*(?:&|and|\/)\s*media)$/i;

function normalizeExactGroups(rawGroups, expectedTabCount, maxTabsPerGroup = MAX_TABS_PER_GROUP) {
  const issues = {
    expectedIds: expectedTabCount,
    returnedGroups: Array.isArray(rawGroups) ? rawGroups.length : 0,
    coveredIds: 0,
    malformedResponse: Array.isArray(rawGroups) ? 0 : 1,
    malformedGroups: 0,
    emptyNames: 0,
    emptyGroups: 0,
    oversizedGroups: 0,
    vagueNames: 0,
    invalidIds: 0,
    duplicateIds: 0,
    missingIds: expectedTabCount
  };
  if (!Array.isArray(rawGroups)) {
    return {
      valid: false,
      groups: [],
      missing: Array.from({ length: expectedTabCount }, (_, i) => i + 1),
      invalidCount: 1,
      issues
    };
  }

  const claimed = new Set();
  const groups = [];
  let structurallyInvalid = false;
  let invalidCount = 0;

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup.name !== 'string' || !Array.isArray(rawGroup.tab_ids)) {
      structurallyInvalid = true;
      invalidCount += 1;
      issues.malformedGroups += 1;
      continue;
    }

    const name = rawGroup.name.trim();
    const tabIds = [];
    const emptyName = !name;
    const emptyGroup = rawGroup.tab_ids.length === 0;
    const oversizedGroup = rawGroup.tab_ids.length > maxTabsPerGroup;
    const vagueName = Boolean(name) && VAGUE_GROUP_NAME_PATTERN.test(name);
    if (emptyName) issues.emptyNames += 1;
    if (emptyGroup) issues.emptyGroups += 1;
    if (oversizedGroup) issues.oversizedGroups += 1;
    if (vagueName) issues.vagueNames += 1;
    const unusableGroup = emptyName || emptyGroup || oversizedGroup;
    if (unusableGroup || vagueName) {
      structurallyInvalid = true;
      invalidCount += 1;
    }

    if (unusableGroup) continue;

    for (const id of rawGroup.tab_ids) {
      if (!Number.isInteger(id) || id < 1 || id > expectedTabCount) {
        structurallyInvalid = true;
        invalidCount += 1;
        issues.invalidIds += 1;
        continue;
      }
      if (claimed.has(id)) {
        structurallyInvalid = true;
        invalidCount += 1;
        issues.duplicateIds += 1;
        continue;
      }
      claimed.add(id);
      tabIds.push(id);
    }

    if (name && tabIds.length > 0) {
      groups.push({ name, color: rawGroup.color || 'grey', tab_ids: tabIds });
    }
  }

  const missing = Array.from({ length: expectedTabCount }, (_, i) => i + 1)
    .filter(id => !claimed.has(id));
  issues.coveredIds = claimed.size;
  issues.missingIds = missing.length;
  return { valid: !structurallyInvalid && missing.length === 0, groups, missing, invalidCount, issues };
}

function isErrorTab(tab) {
  return ERROR_TITLE_PATTERN.test(tab.title || '');
}
