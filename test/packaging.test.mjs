import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop packages include runtime files but not local data", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "electron.mjs");
  assert.equal(pkg.scripts.predist, "npm run prepare-assets");
  assert.ok(pkg.build.files.includes("server.mjs"));
  assert.ok(pkg.build.files.includes("build/icon.png"));
  assert.ok(pkg.build.files.includes("public/**"));
  assert.ok(!pkg.build.files.some((entry) => entry.includes(".codex-control-plane")));
});

test("all desktop platforms have installer targets", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(pkg.build.win.target, ["nsis", "portable"]);
  assert.deepEqual(pkg.build.linux.target, ["AppImage", "deb"]);
});
