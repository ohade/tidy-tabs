// Zen Tidy: a broom next to each Space's clean button. It sends the Space's unpinned tabs to
// Claude Haiku through zen_tidy_claude.py, then files them into colored folders with short names.
// The repository path comes from the zen.tidy.repo-dir pref, which install.sh sets.
(async () => {
  const REPO_DIR = Services.prefs.getStringPref("zen.tidy.repo-dir", "");
  const COLORS_PREF = "zen.tidy.folder-colors";
  const PYTHON_CANDIDATES = ["/opt/homebrew/bin/python3", "/usr/bin/python3"];
  const ERROR_DISPLAY_MS = 10000;
  const MAX_FOLDER_SAMPLE_TITLES = 5;
  const SLIDE_MS = 550;
  const STAGGER_MS = 60;
  const MAX_STAGGER_MS = 900;
  const GLOW_MS = 1800;

  await window.delayedStartupPromise;
  await gZenWorkspaces.promiseInitialized;
  if (!REPO_DIR || gZenWorkspaces.privateWindowOrDisabled) {
    return;
  }

  // file:// URIs are untrusted for loadSubScript, so serve the repository as resource://zen-tidy-repo/.
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution("zen-tidy-repo", Services.io.newURI(PathUtils.toFileURI(REPO_DIR) + "/"));
  const lib = {};
  for (const file of ["lib/partition.js", "zen/tidy-plan.js"]) {
    Services.scriptloader.loadSubScript("resource://zen-tidy-repo/" + file, lib);
  }
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

  function readFolderColors() {
    try {
      return JSON.parse(Services.prefs.getStringPref(COLORS_PREF, "{}"));
    } catch {
      return {};
    }
  }

  function paintFolder(folder, colors = readFolderColors()) {
    const color = colors[folder.id];
    if (color) {
      folder.setAttribute("zen-tidy-color", color);
    }
  }

  function addBroom(separator) {
    const cleanButton = separator.querySelector(".zen-workspace-close-unpinned-tabs-button");
    if (!cleanButton || separator.querySelector(".zen-tidy-button")) {
      return;
    }
    const broom = document.createXULElement("toolbarbutton");
    broom.className = "zen-tidy-button";
    broom.setAttribute("tooltiptext", "Tidy tabs into folders with Claude");
    broom.addEventListener("command", () => tidy(broom));
    cleanButton.before(broom);
  }

  function decorate(root) {
    root.querySelectorAll(".pinned-tabs-container-separator").forEach(addBroom);
    const colors = readFolderColors();
    root.querySelectorAll("zen-folder").forEach(folder => paintFolder(folder, colors));
  }

  function tidyCandidates(workspaceId) {
    return gBrowser.tabs.filter(
      tab =>
        !tab.pinned &&
        !tab.closing &&
        !tab.hasAttribute("zen-essential") &&
        !tab.hasAttribute("zen-empty-tab") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.group?.hasAttribute("split-view-group") &&
        tab.getAttribute("zen-workspace-id") === workspaceId
    );
  }

  // The Space's folders, so the model can file tabs into them before making new ones.
  function existingFolders(workspaceId) {
    const colors = readFolderColors();
    return [...document.querySelectorAll("zen-folder")]
      .filter(folder => folder.getAttribute("zen-workspace-id") === workspaceId && folder.label)
      .map(folder => ({
        element: folder,
        name: folder.label,
        color: colors[folder.id] || "grey",
        titles: folder.tabs
          .filter(tab => !tab.hasAttribute("zen-empty-tab"))
          .slice(0, MAX_FOLDER_SAMPLE_TITLES)
          .map(tab => tab.label),
      }));
  }

  async function askHaiku(tabs, folders) {
    let python = null;
    for (const candidate of PYTHON_CANDIDATES) {
      if (await IOUtils.exists(candidate)) {
        python = candidate;
        break;
      }
    }
    if (!python) {
      throw new Error("python3 not found");
    }
    const proc = await Subprocess.call({
      command: python,
      arguments: [PathUtils.join(REPO_DIR, "zen", "zen_tidy_claude.py")],
      environmentAppend: true,
      stderr: "pipe",
    });
    const request = {
      tabs: tabs.map((tab, index) => ({
        id: index + 1,
        title: tab.label,
        url: tab.linkedBrowser?.currentURI?.spec || "",
      })),
      folders: folders.map(({ name, color, titles }) => ({ name, color, titles })),
    };
    await proc.stdin.write(JSON.stringify(request));
    await proc.stdin.close();
    let output = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      output += chunk;
    }
    await proc.wait();
    let answer;
    try {
      answer = JSON.parse(output);
    } catch {
      throw new Error("helper printed no JSON: " + output.slice(0, 200));
    }
    if (!answer.ok) {
      throw new Error(answer.error || "helper failed");
    }
    return answer;
  }

  function glow(element, delay) {
    setTimeout(() => {
      element.setAttribute("zen-tidy-glow", "true");
      setTimeout(() => element.removeAttribute("zen-tidy-glow"), GLOW_MS);
    }, delay);
  }

  // Slides each tab from where it was to where it landed (the FLIP technique), then glows it.
  function animateTidy(tabs, startRects, touchedFolders) {
    tabs.forEach((tab, index) => {
      const delay = Math.min(index * STAGGER_MS, MAX_STAGGER_MS);
      const from = startRects.get(tab);
      const to = tab.getBoundingClientRect();
      if (from?.height && to.height) {
        tab.animate(
          [
            { transform: `translateY(${from.top - to.top}px) scale(0.96)`, opacity: 0.5 },
            { transform: "none", opacity: 1 },
          ],
          { duration: SLIDE_MS, delay, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" }
        );
      }
      glow(tab, delay + SLIDE_MS / 2);
    });
    touchedFolders.forEach(folder => glow(folder, SLIDE_MS));
  }

  function applyPlan(plan, workspaceId, tabs) {
    const startRects = new Map(tabs.map(tab => [tab, tab.getBoundingClientRect()]));
    const touchedFolders = new Set();
    for (const { tab, label } of plan.renames) {
      tab.zenStaticLabel = label;
      gBrowser._setTabLabel(tab, label, { _zenChangeLabelFlag: true });
    }
    for (const { folder, tabs: folderTabs } of plan.moves) {
      // Folders live in the pinned area, so pin first, as gZenFolders.createFolder does.
      folderTabs.forEach(tab => gBrowser.pinTab(tab));
      folder.addTabs(folderTabs);
      touchedFolders.add(folder);
    }
    const colors = readFolderColors();
    for (const { name, color, tabs: folderTabs } of plan.folders) {
      const folder = gZenFolders.createFolder(folderTabs, { label: name, workspaceId, renameFolder: false });
      colors[folder.id] = color;
      paintFolder(folder, colors);
      touchedFolders.add(folder);
    }
    Services.prefs.setStringPref(COLORS_PREF, JSON.stringify(colors));
    animateTidy(tabs, startRects, touchedFolders);
  }

  async function tidy(broom) {
    if (broom.hasAttribute("tidy-state")) {
      return;
    }
    const workspaceId = broom.closest("[zen-workspace-id]")?.getAttribute("zen-workspace-id");
    const tabs = tidyCandidates(workspaceId);
    if (!tabs.length) {
      return;
    }
    broom.setAttribute("tidy-state", "busy");
    try {
      const folders = existingFolders(workspaceId);
      const answer = await askHaiku(tabs, folders);
      const plan = lib.buildTidyPlan(
        tabs,
        answer,
        folders.map(({ name, element }) => ({ name, folder: element }))
      );
      applyPlan(plan, workspaceId, tabs);
      broom.removeAttribute("tidy-state");
      const moved = plan.moves.reduce((count, move) => count + move.tabs.length, 0);
      broom.setAttribute(
        "tooltiptext",
        `Last tidy: ${moved} into existing folders, ${plan.folders.length} new folders, ` +
          `${plan.renames.length} renamed, ${plan.ungrouped} left`
      );
    } catch (error) {
      console.error("Zen Tidy failed", error);
      broom.setAttribute("tidy-state", "error");
      broom.setAttribute("tooltiptext", "Tidy failed: " + error.message);
      setTimeout(() => broom.removeAttribute("tidy-state"), ERROR_DISPLAY_MS);
    }
  }

  decorate(document);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.localName === "zen-folder") {
            paintFolder(node);
          }
          decorate(node);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})().catch(error => console.error("Zen Tidy init failed", error));
