import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web app manifest is installable and scoped locally", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes("maskable")));
});

test("service worker never caches API or SSE responses", async () => {
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /cacheName = "codex-control-plane-shell-v1"/);
});
