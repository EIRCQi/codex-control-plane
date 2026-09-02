import test from "node:test";
import assert from "node:assert/strict";
import { startupErrorMessage } from "../lib/startup.mjs";

test("port conflicts produce actionable startup guidance", () => {
  const message = startupErrorMessage({ code: "EADDRINUSE" }, 4310);
  assert.match(message, /already in use/);
  assert.match(message, /http:\/\/127\.0\.0\.1:4310/);
  assert.match(message, /lsof -nP -iTCP:4310/);
  assert.match(message, /PORT=4311 npm start/);
});

test("unexpected startup errors retain their message", () => {
  assert.equal(startupErrorMessage(new Error("Permission denied"), 4310), "Failed to start Codex Control Plane: Permission denied");
});
