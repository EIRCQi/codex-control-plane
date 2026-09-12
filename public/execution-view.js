import { agentOutput } from './run-output.js';
import { phaseLabel } from './locale.js';
import { formatDuration } from './run-state.js';
import { setupReportView } from './report-view.js';

const labels = {running:'正在执行', completed:'阶段结束', failed:'执行失败', cancelled:'已取消', budget_exceeded:'预算超限', interrupted:'意外中断', legacy:'旧版输出'};
export function setupExecutionView(root, reportOptions) {
  const select = root.querySelector('[data-execution-select]');
  const note = root.querySelector('[data-execution-note]');
  const report = root.querySelector('[data-execution-report]');
  const empty = root.querySelector('[data-execution-empty]');
  const diagnostics = root.querySelector('[data-execution-diagnostics]');
  const diagnosticBody = root.querySelector('[data-diagnostic-body]');
  const reportView = setupReportView(root, reportOptions);
  let run = null, optionsKey = '', selected = 'latest';
  const entry = () => selected === 'latest' ? run?.executions?.at(-1) : run?.executions?.find(item => String(item.seq) === selected);
  const text = () => {
    const item = entry();
    return item ? (item.legacy ? agentOutput(item.output || '') : item.output || '') : agentOutput(run?.output || '');
  };
  function render() {
    const history = run?.executions || [];
    if (selected !== 'latest' && !history.some(item => String(item.seq) === selected)) selected = 'latest';
    const key = JSON.stringify(history.map(item => [item.seq,item.phase,item.status]));
    if (optionsKey !== key) {
      select.replaceChildren();
      const option = (value, label) => { const node = root.ownerDocument.createElement('option'); node.value = value; node.textContent = label; select.append(node); };
      option('latest', '最新执行（自动跟随）');
      for (const item of [...history].reverse()) option(String(item.seq), item.legacy ? '旧版保留的输出' : `第 ${item.seq} 次 · ${phaseLabel(item.phase)} · ${labels[item.status] || item.status}`);
      optionsKey = key;
    }
    select.value = selected;
    select.disabled = history.length === 0;
    const item = entry(), output = text();
    reportView.update(output, `${run?.id}:${item?.seq ?? 'legacy'}`);
    empty.hidden = Boolean(output);
    empty.textContent = item?.status === 'running' ? '本阶段还没有报告内容，请在“事件”中查看实时进度。' : '这次执行没有输出报告，可查看诊断信息或其他执行记录。';
    note.textContent = item ? `${labels[item.status] || item.status}${item.startedAt ? ` · ${new Date(item.startedAt).toLocaleString('zh-CN')} · ${formatDuration(item.durationMs)}` : ''}${item.status === 'running' ? ' · 输出尚未完成' : ''}${item.outputTruncated ? ' · 报告过长，末尾已截断' : ''}` : '旧版任务输出';
    diagnostics.hidden = !item?.diagnostics;
    if (diagnosticBody.textContent !== (item?.diagnostics || '')) diagnosticBody.textContent = item?.diagnostics || '';
    root.querySelector('[data-diagnostic-note]').textContent = item?.diagnosticsTruncated ? '诊断信息较长，仅保留末尾部分。' : 'Codex 进程的诊断输出；其中可能包含普通提示。';
    for (const button of root.querySelectorAll('[data-copy="output"],[data-download="output"]')) button.disabled = !output;
  }
  select.addEventListener('change', () => { selected = select.value; report.scrollTop = 0; diagnostics.open = false; render(); });
  return {
    update(next) {
      if (run?.id !== next?.id) { selected = 'latest'; optionsKey = ''; diagnostics.open = false; report.scrollTop = 0; }
      run = next; render();
    },
    report: text,
    sequence: () => entry()?.seq ?? null,
  };
}
