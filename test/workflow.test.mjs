import test from "node:test";
import assert from "node:assert/strict";
import { applyRun, approveRun, cancelRun, createRun, discardRun, exceedBudget, prepareRetry, rejectRun, requestMergeApproval, requestWriteApproval, transition } from "../lib/workflow.mjs";

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

test("implemented changes need a second approval", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Read-only analysis started");
  requestWriteApproval(run);
  approveRun(run);
  transition(run, "running", "Implementation started");
  requestMergeApproval(run, { diff: "+change", diffStat: "1 file changed" });
  assert.equal(run.state, "awaiting_merge");
  assert.equal(run.diff, "+change");
  applyRun(run);
  assert.equal(run.state, "completed");
});

test("isolated changes can be discarded", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Analysis started");
  requestWriteApproval(run);
  approveRun(run);
  transition(run, "running", "Implementation started");
  requestMergeApproval(run, { diff: "+change", diffStat: "1 file changed" });
  discardRun(run);
  assert.equal(run.state, "discarded");
});

test("an active run can be cancelled and retried", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Analysis started");
  cancelRun(run);
  assert.equal(run.state, "cancelled");
  assert.equal(run.cancelRequested, true);
  prepareRetry(run);
  assert.equal(run.state, "queued");
  assert.equal(run.retries, 1);
  assert.equal(run.cancelRequested, false);
});

test("a budget-limited run stops and can retry after settings change", () => {
  const run = createRun({ id: "1", repository: "/tmp/repo", prompt: "Fix tests" });
  transition(run, "running", "Analysis started");
  exceedBudget(run, "Run token budget exceeded");
  assert.equal(run.state, "budget_exceeded");
  assert.equal(run.budgetExceeded, true);
  prepareRetry(run);
  assert.equal(run.state, "queued");
  assert.equal(run.budgetExceeded, false);
});
