export const terminalStates = new Set(["completed", "failed", "cancelled"]);

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
