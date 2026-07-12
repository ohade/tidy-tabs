document.addEventListener('DOMContentLoaded', async () => {
  const { lastTidyReport: report } = await chrome.storage.local.get('lastTidyReport');
  const status = document.getElementById('status');
  const message = document.getElementById('message');
  const timestamp = document.getElementById('timestamp');
  const totals = document.getElementById('totals');
  const groups = document.getElementById('groups');
  const warningsSection = document.getElementById('warnings-section');
  const warnings = document.getElementById('warnings');

  if (!report) {
    status.textContent = 'No report';
    status.classList.add('warning');
    message.textContent = 'Run Tidy Tabs to create a report.';
    return;
  }

  status.textContent = report.status;
  status.classList.add(report.status);
  message.textContent = report.message || 'Run completed.';
  timestamp.textContent = new Date(report.timestamp).toLocaleString();

  const reportGroups = Array.isArray(report.groups) ? report.groups : [];
  const tabCount = reportGroups.reduce((sum, group) => sum + (group.count || 0), 0);
  totals.textContent = `${reportGroups.length} groups • ${tabCount} tabs`;

  if (report.warnings?.length) {
    warningsSection.hidden = false;
    for (const warning of report.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      warnings.appendChild(item);
    }
  }

  if (reportGroups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No groups were created.';
    groups.appendChild(empty);
  } else {
    for (const group of reportGroups) {
      const card = document.createElement('article');
      card.className = 'group-card';
      const name = document.createElement('h3');
      name.textContent = group.name;
      const count = document.createElement('p');
      count.textContent = `${group.count} tab${group.count === 1 ? '' : 's'} • ${group.color}`;
      card.append(name, count);
      groups.appendChild(card);
    }
  }

  document.getElementById('close').addEventListener('click', () => window.close());
});
