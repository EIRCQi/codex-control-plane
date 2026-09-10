import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopWindowOptions, trayMenu } from "./lib/desktop.mjs";
import { selectRunner } from './lib/launcher.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(root, "build", "icon.png");
let url;
let reusedRunner = false;
const hasLock = app.requestSingleInstanceLock();
let window = null;
let tray = null;
let quitting = false;
let shutdownRunner = null;
let shutdownComplete = false;

function showWindow() {
  if (!window) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const definitions = trayMenu({ visible: Boolean(window?.isVisible()), reused:reusedRunner });
  tray.setContextMenu(Menu.buildFromTemplate(definitions.map((item) => {
    if (!item.id) return item;
    if (item.id === "toggle") return { ...item, click: () => window?.isVisible() ? window.hide() : showWindow() };
    if (item.id === "browser") return { ...item, click: () => void shell.openExternal(url) };
    if (item.id === "quit") return { ...item, click: () => app.quit() };
    return item;
  })));
}

async function start() {
  process.env.CODEX_CONTROL_PLANE_DATA_DIR = path.join(app.getPath("userData"), "data");
  const selected = await selectRunner({port:Number(process.env.PORT || 4310), start:async () => {
    const {serverReady, shutdown} = await import('./server.mjs');
    const ready = await serverReady;
    return {url:ready.url, shutdown};
  }});
  url = selected.url;
  shutdownRunner = selected.shutdown;
  reusedRunner = selected.reused;
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
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (target === url || target === `${url}/`) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
  });
  await window.loadURL(url);

  const trayIcon = icon.resize({ width: process.platform === "darwin" ? 18 : 22, height: process.platform === "darwin" ? 18 : 22 });
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip(reusedRunner ? 'Codex 控制台 · 已连接现有执行器' : 'Codex 控制台 · 本地执行器运行中');
  tray.on("click", () => window?.isVisible() ? window.hide() : showWindow());
  rebuildTrayMenu();
}

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", (event) => {
    if (shutdownComplete || !shutdownRunner) { quitting = true; return; }
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdownRunner().catch(console.error).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  app.on("activate", showWindow);
  app.whenReady().then(start).catch((error) => {
    console.error(error);
    dialog.showErrorBox("无法启动 Codex 控制台", error.code === "EADDRINUSE" ? `端口 ${Number(process.env.PORT || 4310)} 已被占用。请先退出原执行器，再打开桌面应用。` : `请检查本地执行器状态。\n\n${error.message}`);
    app.quit();
  });
}
