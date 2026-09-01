export const terminalStates = new Set(["completed", "failed", "cancelled", "discarded"]);

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
