import test from "node:test";
import assert from "node:assert/strict";
import { approveRun, createRun, rejectRun, requestWriteApproval, transition } from "../lib/workflow.mjs";

test("a run cannot write before approval", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Read-only analysis started");
  requestWriteApproval(run);
  assert.equal(run.state, "awaiting_approval");
  assert.equal(run.phase, "implementation");
  approveRun(run);
  assert.equal(run.state, "approved");
});

test("rejection terminates a run", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Read-only analysis started");
  requestWriteApproval(run);
  rejectRun(run);
  assert.equal(run.state, "cancelled");
  assert.throws(() => transition(run, "running", "Should fail"));
});
