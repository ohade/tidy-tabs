// Turns the helper's answer into Zen folders and tab renames. Needs lib/partition.js loaded first.
const TIDY_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const MAX_TAB_LABEL_LENGTH = 40;

function folderKey(name) {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

// tabs[i] is the tab sent to the model with id i + 1. existingFolders is [{name, folder}]:
// a group whose name matches one of them is moved into that folder instead of a new one,
// and groups sharing a name end up together.
function buildTidyPlan(tabs, answer, existingFolders = []) {
  const { groups, missing } = normalizeExactGroups(answer.groups, tabs.length);
  const existingByKey = new Map(existingFolders.map(entry => [folderKey(entry.name), entry.folder]));
  const movesByKey = new Map();
  const foldersByKey = new Map();
  for (const group of groups) {
    const key = folderKey(group.name);
    const groupTabs = group.tab_ids.map(id => tabs[id - 1]);
    if (existingByKey.has(key)) {
      const move = movesByKey.get(key) || { folder: existingByKey.get(key), tabs: [] };
      move.tabs.push(...groupTabs);
      movesByKey.set(key, move);
      continue;
    }
    const folder = foldersByKey.get(key) || {
      name: group.name,
      color: TIDY_COLORS.includes(group.color) ? group.color : 'grey',
      tabs: []
    };
    folder.tabs.push(...groupTabs);
    foldersByKey.set(key, folder);
  }
  const folders = [...foldersByKey.values()];
  const moves = [...movesByKey.values()];

  const renamedIds = new Set();
  const renames = [];
  for (const entry of Array.isArray(answer.names) ? answer.names : []) {
    const id = entry && entry.tab_id;
    const label = String((entry && entry.short_name) || '').replace(/\s+/g, ' ').trim()
      .slice(0, MAX_TAB_LABEL_LENGTH);
    if (!Number.isInteger(id) || id < 1 || id > tabs.length || renamedIds.has(id) || !label) continue;
    renamedIds.add(id);
    renames.push({ tab: tabs[id - 1], label });
  }
  return { folders, moves, renames, ungrouped: missing.length };
}
