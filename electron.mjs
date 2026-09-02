import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopWindowOptions, trayMenu } from "./lib/desktop.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(root, "build", "icon.png");
const url = `http://127.0.0.1:${Number(process.env.PORT || 4310)}`;
const hasLock = app.requestSingleInstanceLock();
let window = null;
let tray = null;
let quitting = false;

function showWindow() {
  if (!window) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const definitions = trayMenu({ visible: Boolean(window?.isVisible()) });
  tray.setContextMenu(Menu.buildFromTemplate(definitions.map((item) => {
    if (!item.id) return item;
    if (item.id === "toggle") return { ...item, click: () => window?.isVisible() ? window.hide() : showWindow() };
    if (item.id === "browser") return { ...item, click: () => void shell.openExternal(url) };
    if (item.id === "quit") return { ...item, click: () => { quitting = true; app.quit(); } };
    return item;
  })));
}

async function start() {
  process.env.CODEX_CONTROL_PLANE_DATA_DIR = path.join(app.getPath("userData"), "data");
  const { serverReady } = await import("./server.mjs");
  await serverReady;
  const icon = nativeImage.createFromPath(iconPath);
  window = new BrowserWindow(desktopWindowOptions(icon));
  window.removeMenu();
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
    rebuildTrayMenu();
  });
  window.on("show", rebuildTrayMenu);
  window.on("hide", rebuildTrayMenu);
  window.once("ready-to-show", showWindow);
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  await window.loadURL(url);

  const trayIcon = icon.resize({ width: process.platform === "darwin" ? 18 : 22, height: process.platform === "darwin" ? 18 : 22 });
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("Codex Control Plane · Local runner active");
  tray.on("click", () => window?.isVisible() ? window.hide() : showWindow());
  rebuildTrayMenu();
}

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => (quitting = true));
  app.on("activate", showWindow);
  app.whenReady().then(start).catch((error) => {
    console.error(error);
    app.quit();
  });
}
