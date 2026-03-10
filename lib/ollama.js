const OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3.5:9b';
const BATCH_SIZE = 15;

const SYSTEM_PROMPT = `You organize browser tabs into groups. Output ONLY raw JSON (no markdown fences) with this structure:
{"groups": [{"name": "Group Name", "color": "blue", "tab_ids": [1, 2]}]}
Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange
tab_ids are the numbers from the input list. 3-7 groups. Every tab must be in exactly one group. No text before or after the JSON.`;

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

async function checkOllamaRunning() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function classifyBatch(tabList, model) {
  console.log(`[ollama-batch] Sending ${tabList.split('\n').length} tabs to ${model}`);
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Group these tabs:\n${tabList}` }
      ],
      format: FORMAT_SCHEMA,
      stream: false,
      options: { temperature: 0, num_predict: 4096 },
      think: false
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);

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

async function classifyTabs(tabs, model = DEFAULT_MODEL, onProgress = null) {
  // Split tabs into batches
  const batches = [];
  for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
    batches.push(tabs.slice(i, i + BATCH_SIZE));
  }

  const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[ollama ${ts()}] ${tabs.length} tabs, ${batches.length} batch(es) of ${BATCH_SIZE}`);

  // Process each batch and collect groups
  const allGroups = new Map(); // name -> { color, globalTabIds[] }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const offset = b * BATCH_SIZE; // global offset for tab IDs
    const tabList = batch.map((t, i) => {
      let host = 'unknown';
      try { host = new URL(t.url).hostname; } catch { host = t.url?.slice(0, 30) || 'unknown'; }
      // Sanitize title: remove quotes, truncate, keep readable
      const title = (t.title || 'Untitled').replace(/"/g, "'").replace(/\\/g, '').slice(0, 80);
      return `${i + 1}. ${title} (${host})`;
    }).join('\n');

    if (onProgress) onProgress(b + 1, batches.length);
    console.log(`[ollama ${ts()}] Batch ${b + 1}/${batches.length} (${batch.length} tabs) — sending...`);

    const result = await classifyBatch(tabList, model);
    console.log(`[ollama ${ts()}] Batch ${b + 1}/${batches.length} done — ${result.groups.length} groups`);

    // Merge groups: remap batch-local IDs to global IDs
    for (const group of result.groups) {
      const globalIds = group.tab_ids.map(id => offset + id); // convert to global 1-indexed
      const key = group.name.toLowerCase().trim();

      if (allGroups.has(key)) {
        allGroups.get(key).tab_ids.push(...globalIds);
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

  // Consolidation pass: if too many groups, ask Ollama to merge them
  if (groups.length > 10) {
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
    const mergePrompt = `These ${groups.length} tab groups need to be consolidated into 5-8 groups max.
Merge similar groups together. Output a JSON mapping where each key is the new group name and the value is an array of old group numbers to merge.
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
            { role: 'system', content: 'You merge similar tab groups. Output ONLY raw JSON. Keys are new group names (short, 2-3 words). Values are arrays of old group numbers to merge. Use 5-8 groups. Every old number must appear exactly once.' },
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

        if (mergeMap && Object.keys(mergeMap).length >= 3) {
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
        }
      }
    } catch (err) {
      console.warn(`[ollama] Consolidation failed, using ${groups.length} groups:`, err.message);
    }
  }

  // Validate: all tab IDs must be present
  const allIds = new Set(tabs.map((_, i) => i + 1));
  const assignedIds = new Set(groups.flatMap(g => g.tab_ids));
  const missing = [...allIds].filter(id => !assignedIds.has(id));

  if (missing.length > 0) {
    groups.push({ name: 'Other', color: 'grey', tab_ids: missing });
  }

  return { groups };
}
