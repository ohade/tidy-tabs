function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildUrlCsv(reportGroups) {
  const rows = [['Group', 'Color', 'Title', 'URL']];
  for (const group of Array.isArray(reportGroups) ? reportGroups : []) {
    for (const tab of Array.isArray(group.tabs) ? group.tabs : []) {
      rows.push([group.name, group.color, tab.title, tab.url]);
    }
  }
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function downloadUrlCsv(report) {
  const csv = buildUrlCsv(report.groups);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date(report.timestamp || Date.now()).toISOString().replace(/[:.]/g, '-');
  link.href = objectUrl;
  link.download = `tidy-tabs-urls-${timestamp}.csv`;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

document.addEventListener('DOMContentLoaded', async () => {
  const { lastTidyReport: report } = await chrome.storage.local.get('lastTidyReport');
  const status = document.getElementById('status');
  const message = document.getElementById('message');
  const timestamp = document.getElementById('timestamp');
  const totals = document.getElementById('totals');
  const groups = document.getElementById('groups');
  const warningsSection = document.getElementById('warnings-section');
  const warnings = document.getElementById('warnings');
  const detailsSection = document.getElementById('details-section');
  const details = document.getElementById('details');
  const download = document.getElementById('download');

  document.getElementById('close').addEventListener('click', () => window.close());

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
  const hasExportableTabs = reportGroups.some(group => Array.isArray(group.tabs) && group.tabs.length > 0);
  const tabCount = reportGroups.reduce((sum, group) => sum + (group.count || 0), 0);
  totals.textContent = `${reportGroups.length} groups • ${tabCount} tabs`;

  if (hasExportableTabs) {
    download.hidden = false;
    download.addEventListener('click', () => downloadUrlCsv(report));
  }

  if (report.warnings?.length) {
    warningsSection.hidden = false;
    for (const warning of report.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      warnings.appendChild(item);
    }
  }

  if (Array.isArray(report.details) && report.details.length > 0) {
    detailsSection.hidden = false;
    for (const detail of report.details) {
      const card = document.createElement('article');
      card.className = 'detail-card';
      const title = document.createElement('h3');
      title.textContent = detail.title || 'Diagnostic';
      const summary = document.createElement('p');
      summary.textContent = detail.summary || 'The response failed validation.';
      const reasons = document.createElement('ul');
      for (const reason of Array.isArray(detail.reasons) ? detail.reasons : []) {
        const item = document.createElement('li');
        item.textContent = reason;
        reasons.appendChild(item);
      }
      card.append(title, summary, reasons);
      details.appendChild(card);
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
});
