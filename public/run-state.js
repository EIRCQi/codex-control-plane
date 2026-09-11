export function preferRun(current, incoming, runnerId = null) {
  if (runnerId && incoming.runnerId && incoming.runnerId !== runnerId) return current || null;
  if (!current || (current.runnerId && incoming.runnerId && current.runnerId !== incoming.runnerId)) return incoming;
  if (Number.isSafeInteger(current.revision) && Number.isSafeInteger(incoming.revision)) return current.revision > incoming.revision ? current : incoming;
  return current.updatedAt > incoming.updatedAt ? current : incoming;
}

export function executionDuration(run, now = Date.now()) {
  const completed = run.usage?.durationMs || 0;
  const active = run.executions?.findLast(entry => entry.status === 'running');
  if (!active) return completed;
  const started = Date.parse(active.startedAt);
  return completed + (Number.isFinite(started) ? Math.max(0, now - started) : active.durationMs || 0);
}

export function formatDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function runningMessage(run, now = Date.now()) {
  if (run.cancelRequested && run.starting) return '正在停止并清理，请稍候。';
  if (run.state === 'queued' || run.state === 'approved') return run.starting ? '正在准备隔离工作区……' : '等待可用的执行名额。';
  if (run.state !== 'running') return '';
  const active = run.executions?.findLast(entry => entry.status === 'running');
  if (!active) return '正在准备执行或整理结果……';
  const last = Date.parse(run.lastEventAt || active.startedAt);
  return Number.isFinite(last) && now - last >= 60000
    ? `已 ${formatDuration(now - last)} 未收到新事件；任务仍在运行，可查看诊断或取消。`
    : 'Codex 正在执行，报告和事件会持续更新。';
}
