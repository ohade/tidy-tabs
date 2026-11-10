const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function loadPlan() {
  const context = vm.createContext({});
  for (const file of ['lib/partition.js', 'zen/tidy-plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
  }
  // Plain copies, because arrays built inside the sandbox fail strict deep-equal across realms.
  return (tabList, answer) => JSON.parse(JSON.stringify(context.buildTidyPlan(tabList, answer)));
}

const tabs = ['jira', 'pr', 'notes', 'reddit'].map(name => ({ name }));

test('maps model groups to folders of the original tabs, keeping order and color', () => {
  const plan = loadPlan()(tabs, {
    groups: [
      { name: 'ABC-1 Login', color: 'blue', tab_ids: [2, 1] },
      { name: 'Zen Mods', color: 'purple', tab_ids: [3, 4] }
    ],
    names: []
  });
  assert.deepEqual(plan.folders.map(f => [f.name, f.color, f.tabs.map(t => t.name)]), [
    ['ABC-1 Login', 'blue', ['pr', 'jira']],
    ['Zen Mods', 'purple', ['notes', 'reddit']]
  ]);
  assert.equal(plan.ungrouped, 0);
});

test('drops invalid and duplicate ids and counts tabs left ungrouped', () => {
  const plan = loadPlan()(tabs, {
    groups: [{ name: 'ABC-1 Login', color: 'blue', tab_ids: [1, 1, 9] }],
    names: []
  });
  assert.deepEqual(plan.folders.map(f => f.tabs.map(t => t.name)), [['jira']]);
  assert.equal(plan.ungrouped, 3);
});

test('renames tabs with cleaned short names and ignores empty or unknown entries', () => {
  const plan = loadPlan()(tabs, {
    groups: [],
    names: [
      { tab_id: 1, short_name: '  ABC-1   ticket ' },
      { tab_id: 2, short_name: '' },
      { tab_id: 7, short_name: 'ghost' },
      { tab_id: 3, short_name: 'x'.repeat(60) },
      { tab_id: 1, short_name: 'second name for same tab' }
    ]
  });
  assert.deepEqual(plan.renames.map(r => [r.tab.name, r.label]), [
    ['jira', 'ABC-1 ticket'],
    ['notes', 'x'.repeat(40)]
  ]);
});

test('unknown colors fall back to grey', () => {
  const plan = loadPlan()(tabs, {
    groups: [{ name: 'All', color: 'magenta', tab_ids: [1, 2, 3, 4] }],
    names: []
  });
  assert.equal(plan.folders[0].color, 'grey');
});
