import { app, dialog } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// electron-updater is CJS; under Node's ESM loader `import { autoUpdater } from` fails at
// runtime ("Named export not found") even though it type-checks fine — go through the
// default export instead.
import electronUpdaterPkg from "electron-updater";
import { BRAND } from "@excontrol/shared";
import type { RunningServer } from "@excontrol/backend";

const { autoUpdater } = electronUpdaterPkg;

/**
 * Wraps electron-updater against public GitHub Releases (no token, autoDownload off).
 * Never auto-installs anything — the operator always sees Install now / Skip this
 * version / Remind me later first. Every check's result is also pushed into the shared
 * backend state (`/api/internal/update-status`) so phones/tablets see a banner even
 * though only the control PC itself can run the installer.
 */

interface Prefs {
  skippedVersion?: string;
}

function prefsFile(dataDir: string): string {
  return join(dataDir, "update-prefs.json");
}
function loadPrefs(dataDir: string): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(dataDir), "utf8"));
  } catch {
    return {};
  }
}
function savePrefs(dataDir: string, p: Prefs): void {
  try {
    writeFileSync(prefsFile(dataDir), JSON.stringify(p));
  } catch {
    /* non-fatal — worst case it asks again next time */
  }
}

function stripHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/<[^>]+>/g, "").trim();
}

export interface Updater {
  checkForUpdates: (manual: boolean) => void;
}

export function initUpdater(getServer: () => RunningServer | null, dataDir: string): Updater {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let manual = false;

  async function pushStatus(body: { available: boolean; version?: string; notes?: string; error?: string }): Promise<void> {
    const server = getServer();
    if (!server) {
      console.log("[updater] pushStatus skipped — no server yet");
      return;
    }
    const url = `http://127.0.0.1:${server.port}/api/internal/update-status`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.log("[updater] pushStatus non-200:", res.status, await res.text().catch(() => ""));
    } catch (e) {
      console.log("[updater] pushStatus failed:", e instanceof Error ? e.message : e);
    }
  }

  async function showUpdateDialog(version: string, notes: string): Promise<void> {
    const r = await dialog.showMessageBox({
      type: "info",
      buttons: ["Install now", "Skip this version", "Remind me later"],
      defaultId: 0,
      cancelId: 2,
      message: `${BRAND.name} ${version} is available`,
      detail: `You have ${app.getVersion()}.${notes ? "\n\n" + notes.slice(0, 500) : ""}`,
    });
    if (r.response === 0) {
      await autoUpdater.downloadUpdate();
    } else if (r.response === 1) {
      savePrefs(dataDir, { skippedVersion: version });
    }
    // "Remind me later" (or closing the dialog) does nothing — the next launch or manual
    // check asks again.
  }

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update-available", info.version);
    const notes = stripHtml(typeof info.releaseNotes === "string" ? info.releaseNotes : undefined);
    void pushStatus({ available: true, version: info.version, notes });
    const skipped = loadPrefs(dataDir).skippedVersion === info.version;
    if (skipped && !manual) return; // silently ignore a skipped version on an automatic check
    void showUpdateDialog(info.version, notes);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] update-not-available");
    void pushStatus({ available: false });
    if (manual) {
      void dialog.showMessageBox({ type: "info", message: "You're up to date", detail: `${BRAND.name} ${app.getVersion()} is the latest version.` });
    }
  });

  autoUpdater.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[updater] error event:", msg);
    void pushStatus({ available: false, error: msg });
    if (manual) dialog.showErrorBox("Check for updates", msg);
  });

  autoUpdater.on("update-downloaded", () => {
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        message: "Update downloaded",
        detail: "Restart eXcontrol to finish installing the update.",
      })
      .then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
      });
  });

  return {
    checkForUpdates(isManual: boolean): void {
      console.log("[updater] checkForUpdates called, manual =", isManual, "packaged =", app.isPackaged);
      if (!app.isPackaged) {
        if (isManual) void dialog.showMessageBox({ message: "Updates only run in the installed app, not this dev build." });
        return;
      }
      manual = isManual;
      autoUpdater.checkForUpdates().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("[updater] checkForUpdates() promise rejected:", msg);
        void pushStatus({ available: false, error: msg });
        if (isManual) dialog.showErrorBox("Check for updates", msg);
      });
    },
  };
}
