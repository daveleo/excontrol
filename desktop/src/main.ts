import { app, BrowserWindow, Tray, Menu, shell, nativeImage, clipboard, dialog } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { startServer, type RunningServer } from "@excontrol/backend";
import { BRAND } from "@excontrol/shared";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

/* ---- data dir + env (the backend reads these lazily, so setting them here is enough) ---- */
const dataDir = join(process.env.PROGRAMDATA || app.getPath("userData"), BRAND.dataDirName);
mkdirSync(dataDir, { recursive: true });
process.env.EXCONTROL_DATA_DIR = dataDir;
process.env.EXCONTROL_VERSION = app.getVersion();
process.env.NODE_ENV = "production";
process.env.EXCONTROL_FRONTEND_DIR = app.isPackaged
  ? join(process.resourcesPath, "frontend")
  : join(import.meta.dirname, "..", "..", "frontend", "dist");

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const boundsFile = join(dataDir, "window.json");
const loadBounds = (): Electron.Rectangle | undefined => {
  try {
    return JSON.parse(readFileSync(boundsFile, "utf8"));
  } catch {
    return undefined;
  }
};
const saveBounds = () => {
  if (win && !win.isDestroyed()) {
    try {
      writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
    } catch { /* non-fatal */ }
  }
};

function trayIcon(): Electron.NativeImage {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAt0lEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AU" +
    "jIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkYBKQAAmvUB8Yc5kR0AAAAASUVORK5CYII=";
  return nativeImage.createFromBuffer(Buffer.from(png, "base64"));
}

function localIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return "127.0.0.1";
}

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    ...(loadBounds() ?? { width: 1200, height: 820 }),
    minWidth: 720,
    minHeight: 520,
    title: BRAND.name,
    backgroundColor: "#0d1014",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void win.loadURL(server ? server.url : "about:blank");
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function buildTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip(BRAND.name);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open control panel", click: showWindow },
      {
        label: "Copy address for phones / tablets",
        click: () => clipboard.writeText(server?.url.replace("127.0.0.1", localIp()) ?? ""),
      },
      { type: "separator" },
      { label: "Check for updates…", click: () => void shell.openExternal(`https://github.com/${BRAND.repo}/releases`) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

async function main(): Promise<void> {
  app.setAppUserModelId("tech.expromo.excontrol");

  await app.whenReady();
  // Autostart is registered by the installer (HKLM Run) — no app-side login item.

  try {
    server = await startServer();
  } catch (e) {
    dialog.showErrorBox(BRAND.name, `Could not start:\n\n${e instanceof Error ? e.message : String(e)}`);
    app.quit();
    return;
  }

  buildTray();
  showWindow();

  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => (quitting = true));
  app.on("window-all-closed", () => {}); // stay alive in the tray
  app.on("will-quit", (e) => {
    if (server) {
      e.preventDefault();
      const s = server;
      server = null;
      void s.stop().catch(() => {}).then(() => app.quit());
    }
  });
}
