const OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3.5:4b';
const BATCH_SIZE = 15;
const MAX_CLASSIFICATION_ATTEMPTS = 2;
const MAX_GROUPS_AFTER_CONSOLIDATION = 12;
const MAX_TABS_PER_GROUP = 15;
const ERROR_TITLE_PATTERN = /(?:privacy error|your connection is not private|page not found|404 not found|site can(?:not|'t|’t) be reached|server not found|access denied|error \d{3})/i;
const VAGUE_GROUP_NAME_PATTERN = /^(?:(?:other|misc(?:ellaneous)?|general|uncategorized|various)(?:\s+(?:tabs?|sites?|pages?|web|stuff|items?|content))?|news\s*(?:&|and|\/)\s*media)$/i;

const SYSTEM_PROMPT = `You organize browser tabs into groups. Output ONLY raw JSON (no markdown fences) with this structure:
{"groups": [{"name": "Group Name", "color": "blue", "tab_ids": [1, 2]}]}
Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange
tab_ids are the numbers from the input list. Use 3-8 specific intent groups. Every tab must appear exactly once.
Keep search results and error/privacy pages separate from news, tutorials, and other content. Never use Other or Miscellaneous. No text before or after the JSON.`;

const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] },
          tab_ids: { type: 'array', items: { type: 'integer' } }
        },
        required: ['name', 'color', 'tab_ids']
      }
    }
  },
  required: ['groups']
};

async function checkOllamaReady(model = DEFAULT_MODEL) {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      return { ok: false, error: `Ollama unavailable (HTTP ${resp.status})` };
    }

    const data = await resp.json();
    const installedModels = (data.models || []).map(item => item.name || item.model);
    if (!installedModels.includes(model)) {
      return {
        ok: false,
        error: `Model ${model} is not installed. Run: ollama pull ${model}`
      };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Ollama not running (${err.message})` };
  }
}

async function classifyBatch(tabList, model, strictRetry = false) {
  console.log(`[ollama-batch] Sending ${tabList.split('\n').length} tabs to ${model}`);
  const retryInstruction = strictRetry
    ? '\nIMPORTANT: Return exactly one top-level "groups" key containing one array. Include every tab ID exactly once.'
    : '';
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Group these ${tabList.split('\n').length} tabs by their likely user intent:\n${tabList}${retryInstruction}` }
      ],
      format: FORMAT_SCHEMA,
      stream: false,
      options: { temperature: 0, num_predict: 4096 },
      think: false
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!resp.ok) {
    const rawError = await resp.text();
    let detail = rawError;
    try {
      detail = JSON.parse(rawError).error || rawError;
    } catch {}
    throw new Error(detail ? `Ollama ${resp.status}: ${detail}` : `Ollama error: ${resp.status}`);
  }

  const data = await resp.json();
  const thinkLen = data.message.thinking?.length || 0;
  const durationSec = (data.total_duration / 1e9).toFixed(1);
  console.log(`[ollama-batch] Response: ${durationSec}s, think=${thinkLen} chars, eval=${data.eval_count} tokens`);
  let content = data.message.content;
  content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');

  try {
    return JSON.parse(content);
  } catch (e) {
    console.warn('[ollama-batch] JSON parse failed:', e.message);
    console.warn('[ollama-batch] Raw content:', content.slice(0, 500));
    // Rescue individual group objects via regex
    const rescued = [];
    const re = /\{\s*"name"\s*:\s*"([^"]*)"\s*,\s*"color"\s*:\s*"([^"]*)"\s*,\s*"tab_ids"\s*:\s*\[([0-9,\s]*)\]\s*\}/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const ids = m[3].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (ids.length > 0) rescued.push({ name: m[1], color: m[2], tab_ids: ids });
    }
    if (rescued.length > 0) {
      console.log('[ollama-batch] Rescued', rescued.length, 'groups from malformed JSON');
      return { groups: rescued };
    }
    console.error('[ollama-batch] No groups salvageable');
    return { groups: [] };
  }
}

function normalizeExactGroups(rawGroups, expectedTabCount) {
  if (!Array.isArray(rawGroups)) {
    return { valid: false, groups: [], missing: Array.from({ length: expectedTabCount }, (_, i) => i + 1), invalidCount: 1 };
  }

  const claimed = new Set();
  const groups = [];
  let structurallyInvalid = false;
  let invalidCount = 0;

  for (const rawGroup of rawGroups) {
    if (!rawGroup || typeof rawGroup.name !== 'string' || !Array.isArray(rawGroup.tab_ids)) {
      structurallyInvalid = true;
      invalidCount += 1;
      continue;
    }

    const name = rawGroup.name.trim();
    const tabIds = [];
    if (!name || VAGUE_GROUP_NAME_PATTERN.test(name) || rawGroup.tab_ids.length === 0 || rawGroup.tab_ids.length > MAX_TABS_PER_GROUP) {
      structurallyInvalid = true;
      invalidCount += 1;
    }

    for (const id of rawGroup.tab_ids) {
      if (!Number.isInteger(id) || id < 1 || id > expectedTabCount || claimed.has(id)) {
        structurallyInvalid = true;
        invalidCount += 1;
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
  return { valid: !structurallyInvalid && missing.length === 0, groups, missing, invalidCount };
}

function isExactMergePartition(mergeMap, sourceGroups) {
  if (!mergeMap || typeof mergeMap !== 'object' || Array.isArray(mergeMap) || !Array.isArray(sourceGroups)) return false;

  const sourceGroupCount = sourceGroups.length;
  const entries = Object.entries(mergeMap);
  const minimumGroups = Math.min(6, sourceGroupCount);
  if (entries.length < minimumGroups || entries.length > MAX_GROUPS_AFTER_CONSOLIDATION) return false;

  const seen = new Set();
  for (const [name, indices] of entries) {
    if (!name.trim() || VAGUE_GROUP_NAME_PATTERN.test(name.trim()) || !Array.isArray(indices) || indices.length === 0) return false;
    let mergedTabCount = 0;
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 1 || index > sourceGroupCount || seen.has(index)) return false;
      seen.add(index);
      mergedTabCount += sourceGroups[index - 1].tab_ids.length;
    }
    if (mergedTabCount > MAX_TABS_PER_GROUP) return false;
  }

  return seen.size === sourceGroupCount;
}

function formatTabList(tabs) {
  return tabs.map((tab, index) => {
    let location = 'unknown';
    try {
      const url = new URL(tab.url);
      const path = url.pathname === '/' ? '' : url.pathname.slice(0, 60);
      location = `${url.hostname}${path}`;
    } catch {
      location = tab.url?.slice(0, 80) || 'unknown';
    }
    const title = (tab.title || 'Untitled').replace(/"/g, "'").replace(/\\/g, '').slice(0, 100);
    return `${index + 1}. ${title} (${location})`;
  }).join('\n');
}

function isErrorTab(tab) {
  return ERROR_TITLE_PATTERN.test(tab.title || '');
}

async function classifyTabs(tabs, model = DEFAULT_MODEL, onProgress = null) {
  const indexedTabs = tabs.map((tab, index) => ({ tab, globalId: index + 1 }));
  const errorTabs = indexedTabs.filter(entry => isErrorTab(entry.tab));
  const tabsToClassify = indexedTabs.filter(entry => !isErrorTab(entry.tab));

  // Split tabs into batches
  const batches = [];
  for (let i = 0; i < tabsToClassify.length; i += BATCH_SIZE) {
    batches.push(tabsToClassify.slice(i, i + BATCH_SIZE));
  }

  const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[ollama ${ts()}] ${tabs.length} tabs (${errorTabs.length} known errors), ${batches.length} batch(es) of ${BATCH_SIZE}`);

  // Process each batch and collect groups
  const allGroups = new Map(); // name -> { color, globalTabIds[] }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const tabList = formatTabList(batch.map(entry => entry.tab));

    if (onProgress) onProgress(b + 1, batches.length);
    console.log(`[ollama ${ts()}] Batch ${b + 1}/${batches.length} (${batch.length} tabs) — sending...`);

    let normalized;
    for (let attempt = 1; attempt <= MAX_CLASSIFICATION_ATTEMPTS; attempt++) {
      const result = await classifyBatch(tabList, model, attempt > 1);
      normalized = normalizeExactGroups(result.groups, batch.length);
      if (normalized.valid) break;
      console.warn(`[ollama ${ts()}] Batch ${b + 1}/${batches.length} attempt ${attempt} had invalid coverage; missing=${normalized.missing.length}`);
    }

    if (!normalized.valid) {
      const issueCount = Math.max(normalized.missing.length, normalized.invalidCount);
      throw new Error(`Could not classify ${issueCount} of ${batch.length} tabs after ${MAX_CLASSIFICATION_ATTEMPTS} attempts`);
    }

    console.log(`[ollama ${ts()}] Batch ${b + 1}/${batches.length} done — ${normalized.groups.length} groups`);

    // Merge groups: remap batch-local IDs to global IDs
    for (const group of normalized.groups) {
      const globalIds = group.tab_ids.map(id => batch[id - 1].globalId);
      const key = group.name.toLowerCase().trim();

      if (allGroups.has(key)) {
        const existing = allGroups.get(key);
        if (existing.tab_ids.length + globalIds.length <= MAX_TABS_PER_GROUP) {
          existing.tab_ids.push(...globalIds);
        } else {
          let suffix = 2;
          while (allGroups.has(`${key}#${suffix}`)) suffix += 1;
          allGroups.set(`${key}#${suffix}`, {
            name: `${group.name} ${suffix}`,
            color: group.color,
            tab_ids: globalIds
          });
        }
      } else {
        allGroups.set(key, {
          name: group.name,
          color: group.color,
          tab_ids: globalIds
        });
      }
    }
  }

  let groups = [...allGroups.values()];

  // Consolidation pass: if too many groups, ask Ollama to merge only clearly overlapping intents.
  if (groups.length > MAX_GROUPS_AFTER_CONSOLIDATION) {
    console.log(`[ollama ${ts()}] ${groups.length} groups — running consolidation pass...`);
    const mergeList = groups.map((g, i) => {
      // Include sample tab titles so the model knows what's actually in each group
      const sampleIds = g.tab_ids.slice(0, 3);
      const samples = sampleIds.map(id => {
        const tab = tabs[id - 1];
        if (!tab) return '';
        const title = (tab.title || '').slice(0, 40);
        let host = '';
        try { host = new URL(tab.url).hostname; } catch {}
        return `${title} (${host})`;
      }).filter(Boolean).join(', ');
      return `${i + 1}. "${g.name}" (${g.tab_ids.length} tabs) — e.g.: ${samples}`;
    }).join('\n');
    const mergePrompt = `These ${groups.length} tab groups need to be reduced to 6-${MAX_GROUPS_AFTER_CONSOLIDATION} specific groups.
Merge only groups with clearly overlapping user intent. Do not merge groups merely because they all contain web content or media.
Keep search results, error/privacy pages, archives/references, tutorials, and topical news separate.
Avoid vague names such as General, Miscellaneous, Other, or News & Media.
Output a JSON mapping where each key is the new group name and the value is an array of old group numbers to merge.
Example: {"Development": [1, 3, 7], "News": [2, 5]}
Every old group number must appear exactly once.

Groups:
${mergeList}`;

    const MERGE_SCHEMA = {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'integer' } }
    };

    try {
      const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: `You merge only clearly overlapping tab-group intents. Output ONLY raw JSON. Keys are specific new group names (short, 2-3 words). Values are arrays of old group numbers. Use 6-${MAX_GROUPS_AFTER_CONSOLIDATION} groups. Every old number must appear exactly once with no duplicates.` },
            { role: 'user', content: mergePrompt }
          ],
          format: MERGE_SCHEMA,
          stream: false,
          options: { temperature: 0, num_predict: 2048 },
          think: false
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (resp.ok) {
        const data = await resp.json();
        let mergeMap;
        try {
          mergeMap = JSON.parse(data.message.content);
        } catch {
          // Try regex rescue for the merge map
          const content = data.message.content;
          mergeMap = {};
          const re = /"([^"]+)"\s*:\s*\[([0-9,\s]+)\]/g;
          let m;
          while ((m = re.exec(content)) !== null) {
            mergeMap[m[1]] = m[2].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
          }
        }

        if (isExactMergePartition(mergeMap, groups)) {
          const merged = [];
          const claimed = new Set(); // prevent duplicate tab IDs across groups
          for (const [name, indices] of Object.entries(mergeMap)) {
            const tabIds = [];
            let color = 'grey';
            for (const idx of indices) {
              const orig = groups[idx - 1];
              if (orig) {
                for (const id of orig.tab_ids) {
                  if (!claimed.has(id)) { tabIds.push(id); claimed.add(id); }
                }
                if (color === 'grey') color = orig.color;
              }
            }
            if (tabIds.length > 0) merged.push({ name, color, tab_ids: tabIds });
          }
          console.log(`[ollama ${ts()}] Consolidated ${groups.length} → ${merged.length} groups`);
          groups = merged;
        } else {
          console.warn(`[ollama] Rejected invalid consolidation map; keeping ${groups.length} source groups`);
        }
      }
    } catch (err) {
      console.warn(`[ollama] Consolidation failed, using ${groups.length} groups:`, err.message);
    }
  }

  if (errorTabs.length > 0) {
    for (let i = 0; i < errorTabs.length; i += MAX_TABS_PER_GROUP) {
      const chunkNumber = Math.floor(i / MAX_TABS_PER_GROUP) + 1;
      groups.push({
        name: chunkNumber === 1 ? 'Errors' : `Errors ${chunkNumber}`,
        color: 'red',
        tab_ids: errorTabs.slice(i, i + MAX_TABS_PER_GROUP).map(entry => entry.globalId)
      });
    }
  }

  const finalGroups = normalizeExactGroups(groups, tabs.length);
  if (!finalGroups.valid) {
    throw new Error(`Final grouping lost coverage for ${finalGroups.missing.length} of ${tabs.length} tabs`);
  }

  return { groups: finalGroups.groups };
}
