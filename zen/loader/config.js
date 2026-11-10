// Zen Tidy loader (first line is skipped by Firefox). Runs <profile>/chrome/JS/*.uc.js in every browser window.
// Uninstall: delete this file and defaults/pref/config-prefs.js from Zen.app/Contents/Resources, then restart Zen.
// Progress and errors go to the zen.tidy.loader-status pref, readable in about:config or prefs.js.
const zenTidyLoaderStatus = message => {
  try {
    Services.prefs.setStringPref("zen.tidy.loader-status", new Date().toISOString() + " " + message);
  } catch (error) {}
};
try {
  const BROWSER_URL = "chrome://browser/content/browser.xhtml";
  const userScripts = () => {
    const jsDir = Services.dirsvc.get("UChrm", Ci.nsIFile);
    jsDir.append("JS");
    const scripts = [];
    if (!jsDir.exists()) {
      return scripts;
    }
    const entries = jsDir.directoryEntries;
    while (entries.hasMoreElements()) {
      const file = entries.getNext().QueryInterface(Ci.nsIFile);
      if (file.leafName.endsWith(".uc.js")) {
        scripts.push(file);
      }
    }
    return scripts.sort((a, b) => a.leafName.localeCompare(b.leafName));
  };
  // Firefox refuses to load browser scripts from file:// URIs ("Trying to load untrusted URI"),
  // so the profile's JS folder is served as resource://zen-tidy-js/.
  const resourceHandler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  const jsFolder = Services.dirsvc.get("UChrm", Ci.nsIFile);
  jsFolder.append("JS");
  resourceHandler.setSubstitution("zen-tidy-js", Services.io.newFileURI(jsFolder));
  const loadUserScripts = win => {
    const failures = [];
    const scripts = userScripts();
    for (const script of scripts) {
      try {
        Services.scriptloader.loadSubScriptWithOptions("resource://zen-tidy-js/" + script.leafName, {
          target: win,
          ignoreCache: true,
        });
      } catch (error) {
        failures.push(script.leafName + ": " + error);
      }
    }
    zenTidyLoaderStatus(`loaded ${scripts.length - failures.length}/${scripts.length} scripts ${failures.join("; ")}`);
  };
  Services.obs.addObserver(
    {
      observe(win) {
        win.addEventListener(
          "DOMContentLoaded",
          () => {
            if (win.location.href !== BROWSER_URL) {
              return;
            }
            try {
              loadUserScripts(win);
            } catch (error) {
              zenTidyLoaderStatus("window error: " + error);
            }
          },
          { once: true }
        );
      },
    },
    "chrome-document-global-created"
  );
  zenTidyLoaderStatus("observer registered");
} catch (error) {
  zenTidyLoaderStatus("init error: " + error);
}
