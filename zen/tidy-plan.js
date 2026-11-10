// Turns the helper's answer into Zen folders and tab renames. Needs lib/partition.js loaded first.
const TIDY_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const MAX_TAB_LABEL_LENGTH = 40;

// tabs[i] is the tab sent to the model with id i + 1.
function buildTidyPlan(tabs, answer) {
  const { groups, missing } = normalizeExactGroups(answer.groups, tabs.length);
  const folders = groups.map(group => ({
    name: group.name,
    color: TIDY_COLORS.includes(group.color) ? group.color : 'grey',
    tabs: group.tab_ids.map(id => tabs[id - 1])
  }));

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
  return { folders, renames, ungrouped: missing.length };
}
