export const notificationKinds = {
  awaiting_approval: { kind: "approval", title: "需要批准写入", message: "分析已完成，等待批准修改文件。" },
  awaiting_merge: { kind: "approval", title: "代码变更待审批", message: "检查隔离工作区中的变更，再选择应用或丢弃。" },
  completed: { kind: "result", title: "任务已完成", message: "任务已成功完成。" },
  failed: { kind: "result", title: "任务失败", message: "任务因错误而停止。" },
  cancelled: { kind: "result", title: "任务已取消", message: "任务已取消。" },
  budget_exceeded: { kind: "result", title: "任务因预算限制停止", message: "任务已达到设置的 Token 上限。" },
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
