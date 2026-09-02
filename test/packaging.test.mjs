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

test("tag builds publish checksummed and attested releases", async () => {
  const workflow = await readFile(new URL("../.github/workflows/build-desktop.yml", import.meta.url), "utf8");
  assert.match(workflow, /Verify tag matches package version/);
  assert.match(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
});

test("icon generator passes filesystem paths to sharp", async () => {
  const generator = await readFile(new URL("../scripts/generate-icon.mjs", import.meta.url), "utf8");
  assert.match(generator, /fileURLToPath\(new URL/);
  assert.match(generator, /toFile\(output\)/);
  assert.doesNotMatch(generator, /path\.dirname\(output\.pathname\)/);
});
