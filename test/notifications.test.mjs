import test from "node:test";
import assert from "node:assert/strict";
import { notificationForTransition } from "../public/notifications.js";

test("creates an approval notification only when state changes", () => {
  const previous = { id: "1", state: "running" };
  const run = { id: "1", state: "awaiting_approval", prompt: "Fix tests", updatedAt: "2026-09-02T00:00:00Z" };
  assert.equal(notificationForTransition(previous, run).kind, "approval");
  assert.equal(notificationForTransition(run, run), null);
});

test("uses the run error in failure notifications", () => {
  const notification = notificationForTransition(
    { id: "1", state: "running" },
    { id: "1", state: "failed", prompt: "Fix tests", error: "Tests failed", updatedAt: "2026-09-02T00:00:00Z" },
  );
  assert.equal(notification.kind, "result");
  assert.equal(notification.message, "Tests failed");
});

test("ignores non-notifiable transitions and initial history", () => {
  assert.equal(notificationForTransition({ id: "1", state: "queued" }, { id: "1", state: "running" }), null);
  assert.equal(notificationForTransition(null, { id: "1", state: "completed" }), null);
});
