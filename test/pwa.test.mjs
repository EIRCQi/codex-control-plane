import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web app manifest is installable and scoped locally", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes("maskable")));
});

test("service worker bypasses APIs and mutations, rejects failed assets, and does not serve HTML as JS", async () => {
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = {};
  let writes = 0;
  let network = async () => new Response("failure", {status:500});
  runInNewContext(source, {
    self: { location: { origin:"http://127.0.0.1:4310" }, addEventListener: (name, fn) => listeners[name] = fn },
    caches: { open: async () => ({ put: async () => writes++, match: async () => undefined }) },
    URL, Response, fetch: (...args) => network(...args),
  });
  const dispatch = async (pathname, method = "GET") => {
    let response;
    listeners.fetch({ request: { url:`http://127.0.0.1:4310${pathname}`, method }, respondWith: (value) => response = value, waitUntil: () => {} });
    return response;
  };
  assert.equal(await dispatch("/api/events"), undefined);
  assert.equal(await dispatch("/api/runs", "POST"), undefined);
  assert.equal(await dispatch("/app.js", "POST"), undefined);
  assert.equal((await dispatch("/app.js")).status, 500);
  assert.equal(writes, 0);
  network = async () => { throw new Error("offline"); };
  const offline = await dispatch("/app.js");
  assert.equal(offline.status, 503);
  assert.equal(await offline.text(), "Runner unavailable");
});
