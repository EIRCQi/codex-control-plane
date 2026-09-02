export const notificationKinds = {
  awaiting_approval: { kind: "approval", title: "Write approval required", message: "Analysis is complete and waiting for permission to modify files." },
  awaiting_merge: { kind: "approval", title: "Changes ready for review", message: "Review the isolated diff and apply or discard it." },
  completed: { kind: "result", title: "Run completed", message: "The task finished successfully." },
  failed: { kind: "result", title: "Run failed", message: "The task stopped with an error." },
  cancelled: { kind: "result", title: "Run cancelled", message: "The task was cancelled." },
  budget_exceeded: { kind: "result", title: "Run stopped by budget", message: "A configured token limit stopped the task." },
};

export function notificationForTransition(previous, run) {
  if (!previous || previous.state === run.state) return null;
  const definition = notificationKinds[run.state];
  if (!definition) return null;
  return {
    id: `${run.id}:${run.state}:${run.updatedAt || run.createdAt}`,
    runId: run.id,
    state: run.state,
    kind: definition.kind,
    title: definition.title,
    message: run.state === "failed" && run.error ? run.error : definition.message,
    task: run.prompt,
    at: run.updatedAt || new Date().toISOString(),
    read: false,
  };
}
