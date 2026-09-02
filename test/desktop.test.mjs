import test from "node:test";
import assert from "node:assert/strict";
import { desktopWindowOptions, trayMenu } from "../lib/desktop.mjs";

test("desktop window keeps renderer privileges isolated", () => {
  const options = desktopWindowOptions("icon");
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
});

test("tray menu reflects window visibility and exposes explicit quit", () => {
  assert.equal(trayMenu({ visible: true }).find((item) => item.id === "toggle").label, "Hide Control Plane");
  const hidden = trayMenu({ visible: false });
  assert.equal(hidden.find((item) => item.id === "toggle").label, "Show Control Plane");
  assert.ok(hidden.some((item) => item.id === "quit"));
});
