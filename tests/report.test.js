const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const reportSource = fs.readFileSync(path.resolve(__dirname, '..', 'report.js'), 'utf8');

function loadReportScript() {
  const context = vm.createContext({
    console,
    document: { addEventListener: () => {} },
    setTimeout,
    URL
  });
  vm.runInContext(reportSource, context, { filename: 'report.js' });
  return context;
}

test('URL CSV contains final group, title, and URL with safe escaping', () => {
  const context = loadReportScript();
  context.groups = [{
    name: 'Code "Review"',
    color: 'blue',
    count: 2,
    tabs: [
      { title: '=IMPORTXML("bad")', url: 'https://github.com/acme/repo/pull/1' },
      { title: 'Build, passing', url: 'https://ci.example/job/1' }
    ]
  }];

  const csv = vm.runInContext('buildUrlCsv(groups)', context);

  assert.match(csv, /^"Group","Color","Title","URL"\r\n/);
  assert.match(csv, /"Code ""Review""","blue","'=IMPORTXML\(""bad""\)","https:\/\/github\.com\/acme\/repo\/pull\/1"/);
  assert.match(csv, /"Build, passing","https:\/\/ci\.example\/job\/1"/);
  assert.equal(csv.endsWith('\r\n'), true);
});

test('URL CSV remains a valid header-only export for older reports', () => {
  const context = loadReportScript();
  assert.equal(
    vm.runInContext('buildUrlCsv([{ name: "Legacy", color: "grey", count: 2 }])', context),
    '"Group","Color","Title","URL"\r\n'
  );
});
