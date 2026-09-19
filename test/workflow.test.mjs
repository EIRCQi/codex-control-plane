import test from "node:test";
import assert from "node:assert/strict";
import { applyRun, approveRun, cancelRun, createRun, discardRun, exceedBudget, prepareRetry, rejectRun, requestMergeApproval, requestWriteApproval, restoreActivation, stageActivation, transition } from "../lib/workflow.mjs";

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


test("read-only tasks cannot enter write approvals or apply changes", () => {
  const run = createRun({ id: "review", repository: "/tmp/repo", prompt: "Review", mode: "review" });
  transition(run, "running", "Reviewing");
  assert.throws(() => requestWriteApproval(run), /Read-only/);
  run.state = "awaiting_approval";
  assert.throws(() => approveRun(run), /Read-only/);
  run.state = "running"; run.phase = "implementation";
  assert.throws(() => requestMergeApproval(run, {diff:"", diffStat:""}), /Read-only/);
  run.state = "awaiting_merge";
  assert.throws(() => applyRun(run), /Read-only/);
  run.state = "failed";
  prepareRetry(run);
  assert.equal(run.phase, "analysis");
});

test('interrupted approvals restore the decision without refunding concurrent usage', () => {
  const run=createRun({id:'approval',repository:'/tmp/repo',prompt:'Plan'});
  transition(run,'running','Analysis');requestWriteApproval(run);
  const events=structuredClone(run.events),revision=run.revision;
  stageActivation(run,next=>{approveRun(next);next.queuedAction='implementation';});
  const saved=JSON.parse(JSON.stringify(run));saved.usage.totalTokens=30;
  assert.equal(restoreActivation(saved),true);
  assert.equal(saved.state,'awaiting_approval');assert.deepEqual(saved.events,events);
  assert.equal(saved.usage.totalTokens,30);assert.ok(saved.revision>revision);
  assert.equal(saved.activationPending,undefined);assert.equal(restoreActivation(saved),false);
});

test('interrupted retries preserve cancellation, retry count and prior write approvals', () => {
  const run=createRun({id:'retry',repository:'/tmp/repo',prompt:'Fix'});
  transition(run,'running','Analysis');requestWriteApproval(run);approveRun(run);cancelRun(run);
  run.error='Prior cancellation';run.retries=2;
  const events=structuredClone(run.events);
  stageActivation(run,next=>{prepareRetry(next);next.state='approved';next.queuedAction='implementation';});
  assert.equal(restoreActivation(run),true);
  assert.equal(run.state,'cancelled');assert.equal(run.cancelRequested,true);assert.equal(run.retries,2);
  assert.equal(run.phase,'implementation');assert.equal(run.error,'Prior cancellation');assert.deepEqual(run.events,events);
});

test('invalid activations and malformed rollback records never create approval', () => {
  const run=createRun({id:'invalid',repository:'/tmp/repo',prompt:'Plan'}),before=structuredClone(run);
  assert.throws(()=>stageActivation(run,approveRun),/not awaiting approval/);assert.deepEqual(run,before);
  run.activationPending={state:'approved',eventCount:0};
  const malformed=structuredClone(run);
  assert.throws(()=>restoreActivation(run),/Invalid pending/);assert.deepEqual(run,malformed);
});
