import { messageText } from './locale.js';

export function setupChangeCheck({root, request = fetch, timeoutMs = 15000}) {
  const button = root.querySelector('[data-check-changes]');
  const status = root.querySelector('[data-check-status]');
  let selected = null, connected = false, pending = null, generation = 0;
  function sync() { button.disabled = !selected || selected.state !== 'awaiting_merge' || selected.starting || !connected || Boolean(pending); }
  button.addEventListener('click', async () => {
    if (button.disabled || pending) return;
    const seq = generation, id = selected.id;
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    status.textContent = '正在检查原仓库和补丁……'; sync();
    try {
      const response = await request(`/api/runs/${id}/change-check`, {signal:controller.signal});
      const result = await response.json();
      if (generation !== seq) return;
      if (!response.ok) throw new Error(result.error || `检查失败（${response.status}）`);
      if (result.revision !== selected.revision) { status.textContent = '任务状态已改变，请重新检查。'; return; }
      status.textContent = result.canApply ? '检查通过，当前补丁可应用。正式应用时会再次检查原仓库。' : `暂时无法应用：${messageText(result.error)}`;
    } catch (error) {
      if (generation === seq) status.textContent = controller.signal.aborted ? '检查超时，请确认执行器和 Git 正常后重试。' : messageText(error.message);
    } finally {
      clearTimeout(timer);
      if (pending === controller) pending = null;
      sync();
    }
  });
  return {
    update(run, online) {
      const changed = run?.id !== selected?.id || run?.revision !== selected?.revision || run?.runnerId !== selected?.runnerId || run?.state !== selected?.state || online !== connected;
      selected = run; connected = online;
      root.hidden = run?.state !== 'awaiting_merge';
      if (changed) {
        generation++; pending?.abort(); pending = null;
        status.textContent = online ? '可先检查原仓库是否仍与分析时一致；此操作不会修改文件。' : '恢复连接后可以重新检查。';
      }
      sync();
    },
  };
}
