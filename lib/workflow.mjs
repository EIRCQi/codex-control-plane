import { emptyUsage } from "./usage.mjs";

export const terminalStates = new Set(["completed", "failed", "cancelled", "discarded", "budget_exceeded"]);

export function createRun({ id, repository, prompt }) {
  return {
    id,
    repository,
    prompt,
    state: "queued",
    phase: "analysis",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [{ type: "run.created", message: "Task queued", at: new Date().toISOString() }],
    logs: [],
    retries: 0,
    executionSeq: 0,
    usage: emptyUsage(),
    usageSeen: [],
    queuedAction: "analysis",
    budgetExceeded: false,
    cancelRequested: false,
    output: "",
    diff: "",
    diffStat: "",
    worktree: null,
    branch: null,
    error: null,
  };
}

export function transition(run, state, message, extra = {}) {
  if (terminalStates.has(run.state)) throw new Error(`Run is already ${run.state}`);
  const at = new Date().toISOString();
  Object.assign(run, extra, { state, updatedAt: at });
  run.events.push({ type: `run.${state}`, message, at });
  return run;
}

export function requestWriteApproval(run) {
  if (run.state !== "running" || run.phase !== "analysis") {
    throw new Error("Write approval can only follow analysis");
  }
  return transition(run, "awaiting_approval", "Analysis complete; write access requested", {
    phase: "implementation",
  });
}

export function approveRun(run) {
  if (run.state !== "awaiting_approval") throw new Error("Run is not awaiting approval");
  return transition(run, "approved", "Write access approved");
}

export function rejectRun(run) {
  if (run.state !== "awaiting_approval") throw new Error("Run is not awaiting approval");
  return transition(run, "cancelled", "Write access rejected");
}

export function requestMergeApproval(run, { diff, diffStat }) {
  if (run.state !== "running" || run.phase !== "implementation") {
    throw new Error("Merge approval can only follow implementation");
  }
  return transition(run, "awaiting_merge", "Implementation complete; repository changes require approval", {
    phase: "review",
    diff,
    diffStat,
  });
}

export function applyRun(run) {
  if (run.state !== "awaiting_merge") throw new Error("Run is not awaiting change approval");
  return transition(run, "completed", "Changes applied to the original working tree");
}

export function discardRun(run) {
  if (run.state !== "awaiting_merge") throw new Error("Run is not awaiting change approval");
  return transition(run, "discarded", "Isolated changes discarded");
}

export function cancelRun(run) {
  if (!["queued", "running", "approved"].includes(run.state)) {
    throw new Error("Only an active run can be cancelled");
  }
  run.cancelRequested = true;
  return transition(run, "cancelled", "Run cancelled by user");
}

export function prepareRetry(run) {
  if (!["failed", "cancelled", "budget_exceeded"].includes(run.state)) {
    throw new Error("Only a failed, cancelled or budget-limited run can be retried");
  }
  const at = new Date().toISOString();
  Object.assign(run, {
    state: "queued",
    updatedAt: at,
    error: null,
    cancelRequested: false,
    budgetExceeded: false,
    retries: (run.retries || 0) + 1,
  });
  run.events.push({ type: "run.retried", message: `Retry ${run.retries} queued`, at });
  return run;
}

export function exceedBudget(run, message) {
  if (!["queued", "running", "approved"].includes(run.state)) {
    throw new Error("Only an active run can exceed its budget");
  }
  run.cancelRequested = true;
  run.budgetExceeded = true;
  return transition(run, "budget_exceeded", message);
}
