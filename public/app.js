import { setupTaskComposer } from "./task-composer.js";
import { notify } from "./feedback.js";
import { captureView, restoreView, createRunList, updateMarkup } from "./live-view.js";
import { createEventViewer } from "./event-viewer.js";
import { setupOnboarding } from './onboarding.js';
import { setupEnvironment } from "./environment.js";
import { agentOutput } from "./run-output.js";
import { notificationForTransition, notificationKinds } from "./notifications.js";
import { messageText, phaseLabel, eventLabel } from './locale.js';

const runsEl = document.querySelector("#runs");
const emptyEl = document.querySelector("#empty");
const dialog = document.querySelector("#task-dialog");
const runDialog = document.querySelector("#run-dialog");
let currentRuns = [];
let runnerConnected = false;
let loginBusy = false;
let onboarding;
let visibleLimit = 20;
let detailTab = "overview";
const detailTabViews = new Map();
let currentSection = 'runs-panel';
let settingsDirty = false;
let detailRunId = null;
let renderedDetailRun = null;
let projects = [];
let templates = [];
const eventViewer = createEventViewer(document.querySelector('#event-viewer'), {isActive: () => runDialog.open && detailTab === 'events'});
const notificationStorageKey = "codex-control-plane.notifications.v1";
const notificationPreferenceKey = "codex-control-plane.notification-preferences.v1";
let notifications = readLocal(notificationStorageKey, []);
let notificationPreferences = readLocal(notificationPreferenceKey, { approvals: true, results: true });
if (!Array.isArray(notifications)) notifications = [];
if (!notificationPreferences || typeof notificationPreferences !== "object") notificationPreferences = { approvals: true, results: true };
const statusLabel = {
  queued: "排队中",
  running: "执行中",
  awaiting_approval: "等待审批",
  awaiting_merge: "变更审批",
  approved: "已批准",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  discarded: "已丢弃",
  budget_exceeded: "预算超限",
};

const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatTokens = (value = 0) => Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatDuration = (ms = 0) => ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
const terminalStates = new Set(["completed", "failed", "cancelled", "discarded", "budget_exceeded"]);

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* UI remains usable if storage is unavailable. */ }
}

function renderNotifications() {
  const unread = notifications.filter((item) => !item.read).length;
  const badge = document.querySelector("#notification-badge");
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : unread;
  document.querySelector("#notification-list").innerHTML = notifications.length ? notifications.map((item) => `
    <button type="button" class="notification-entry ${item.read ? "" : "unread"}" data-notification-id="${escapeHtml(item.id)}" data-run-id="${escapeHtml(item.runId)}">
      <i></i><div><strong>${escapeHtml(notificationKinds[item.state]?.title || item.title)}</strong><p>${escapeHtml(item.task)}</p><time>${new Date(item.at).toLocaleString('zh-CN')}</time></div>
    </button>`).join("") : '<p class="notification-empty">暂无通知。</p>';
  document.querySelectorAll("[data-notification-id]").forEach((item) => item.addEventListener("click", () => {
    const notification = notifications.find((entry) => entry.id === item.dataset.notificationId);
    if (notification) notification.read = true;
    writeLocal(notificationStorageKey, notifications);
    renderNotifications();
    closeNotifications();
    const run = currentRuns.find((entry) => entry.id === item.dataset.runId);
    if (run) openRunDetail(run);
  }));
  document.querySelector("#notify-approvals").checked = notificationPreferences.approvals;
  document.querySelector("#notify-results").checked = notificationPreferences.results;
  const permission = !window.Notification ? "unsupported" : Notification.permission;
  document.querySelector("#notification-permission-status").textContent = permission === "granted" ? "已启用桌面提醒" : permission === "denied" ? "浏览器已阻止桌面提醒" : permission === "unsupported" ? "此浏览器不支持桌面提醒" : "尚未授权桌面提醒";
  document.querySelector("#enable-system-notifications").hidden = permission === "granted" || permission === "unsupported";
}

function addNotification(notification) {
  if (!notification || notifications.some((item) => item.id === notification.id)) return;
  notifications.unshift(notification);
  notifications = notifications.slice(0, 50);
  writeLocal(notificationStorageKey, notifications);
  renderNotifications();
  const allowed = notification.kind === "approval" ? notificationPreferences.approvals : notificationPreferences.results;
  if (allowed && window.Notification && Notification.permission === "granted") {
    try {
      const desktop = new Notification(notification.title, { body: notification.task, tag: notification.id });
      desktop.onclick = () => { window.focus(); const run = currentRuns.find((item) => item.id === notification.runId); if (run) openRunDetail(run); desktop.close(); };
    } catch { /* In-app notifications still work when desktop alerts are unavailable. */ }
  }
}

function filteredRuns(runs) {
  const query = document.querySelector("#run-search").value.trim().toLowerCase();
  const state = document.querySelector("#state-filter").value;
  const projectId = document.querySelector("#project-filter").value;
  const showArchived = document.querySelector("#show-archived").checked;
  return runs.filter((run) => {
    if (run.archived !== showArchived) return false;
    if (query && !`${run.prompt} ${run.repository}`.toLowerCase().includes(query)) return false;
    if (projectId && run.projectId !== projectId) return false;
    if (state === "active" && !["queued", "running", "approved"].includes(run.state)) return false;
    if (state === "approvals" && !["awaiting_approval", "awaiting_merge"].includes(run.state)) return false;
    if (state && !["active", "approvals"].includes(state) && run.state !== state) return false;
    return true;
  });
}

function renderUsage(runs) {
  const total = runs.reduce((sum, run) => {
    const usage = run.usage || {};
    sum.input += usage.inputTokens || 0;
    sum.cached += usage.cachedInputTokens || 0;
    sum.output += usage.outputTokens || 0;
    sum.tokens += usage.totalTokens || 0;
    sum.duration += usage.durationMs || 0;
    if (usage.model) sum.models[usage.model] = (sum.models[usage.model] || 0) + (usage.totalTokens || 0);
    return sum;
  }, { input: 0, cached: 0, output: 0, tokens: 0, duration: 0, models: {} });
  document.querySelector("#total-tokens").textContent = formatTokens(total.tokens);
  document.querySelector("#input-tokens").textContent = formatTokens(total.input);
  document.querySelector("#cached-tokens").textContent = `缓存命中 ${formatTokens(total.cached)}`;
  document.querySelector("#output-tokens").textContent = formatTokens(total.output);
  document.querySelector("#agent-time").textContent = formatDuration(total.duration);
  const denominator = Math.max(1, total.input + total.output);
  document.querySelector("#input-bar").style.width = `${(Math.max(0, total.input - total.cached) / denominator) * 100}%`;
  document.querySelector("#cached-bar").style.width = `${(total.cached / denominator) * 100}%`;
  document.querySelector("#output-bar").style.width = `${(total.output / denominator) * 100}%`;
  const models = Object.entries(total.models).sort((a, b) => b[1] - a[1]);
  document.querySelector("#model-list").innerHTML = models.length ? models.map(([model, tokens]) => `<div><span>${escapeHtml(model)}</span><strong>${formatTokens(tokens)} Token</strong></div>`).join("") : "<p>暂无模型用量数据</p>";
  const rows = runs.filter((run) => run.usage?.totalTokens || run.usage?.durationMs).map((run) => `<tr><td title="${escapeHtml(run.prompt)}">${escapeHtml(run.prompt.slice(0, 42))}</td><td>${escapeHtml(run.usage.model || "—")}</td><td>${formatTokens(run.usage.inputTokens)}</td><td>${formatTokens(run.usage.cachedInputTokens)}</td><td>${formatTokens(run.usage.outputTokens)}</td><td><strong>${formatTokens(run.usage.totalTokens)}</strong></td><td>${formatDuration(run.usage.durationMs)}</td></tr>`).join("");
  document.querySelector("#usage-rows").innerHTML = rows || '<tr><td colspan="7" class="no-usage">Codex 返回首条用量事件后，这里会显示统计。</td></tr>';
}

function showError(message) {
  message = messageText(message);
  const banner = document.querySelector("#operation-error");
  document.querySelector("#operation-error-message").textContent = message;
  banner.hidden = false;
  if (dialog.open) document.querySelector("#form-error").textContent = message;
  if (runDialog.open) document.querySelector("#detail-error").textContent = message;
}

async function checkedFetch(url, options) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(messageText(body.error) || `请求失败（${response.status}）`);
    }
    if (options?.method && !['GET','HEAD'].includes(options.method.toUpperCase())) {
      document.querySelector('#operation-error').hidden = true;
      if (runDialog.open) document.querySelector('#detail-error').textContent = '';
    }
    return response;
  } catch (error) {
    const translated = messageText(error.message);
    showError(translated);
    throw new Error(translated, {cause:error});
  }
}
window.addEventListener("unhandledrejection", (event) => {
  showError(event.reason?.message || "操作失败，请重试。");
  event.preventDefault();
});
const environment = setupEnvironment({ request: checkedFetch, escapeHtml, onReport:report => onboarding?.environmentChanged(report) });
document.querySelector("#dismiss-error").addEventListener("click", () => { document.querySelector("#operation-error").hidden = true; });
const composer = setupTaskComposer({
  request: checkedFetch, escapeHtml, notify,
  onNeedProject: () => {
    const projectForm = document.querySelector("#project-form");
    projectForm.hidden = false; navigate("catalog-panel"); projectForm.elements.name.focus();
    notify("请先添加本地仓库，再创建第一个任务");
  },
  onCreated: async (created) => {
    clearFilters();
    openRunDetail(acceptRun(created));
  },
});
const pendingActions = new Map();
onboarding = setupOnboarding({
  request:checkedFetch, notify,
  onEnvironment:() => navigate('environment-panel'),
  onProject:() => { const form = document.querySelector('#project-form'); form.hidden = false; navigate('catalog-panel'); form.elements.name.focus(); },
  onTask:() => composer.open(),
  onSignedIn:() => { void environment.refresh(); },
  onBusyChange:(busy) => {
    loginBusy = busy;
    composer.connectionChanged(runnerConnected && !loginBusy);
    document.querySelector('#new-task').disabled = !runnerConnected || loginBusy;
    updatePendingButtons();
  },
});
function acceptRun(incoming) {
  const current = currentRuns.find((run) => run.id === incoming.id);
  // The SSE stream may already have delivered a later state than the HTTP reply.
  const latest = current?.updatedAt > incoming.updatedAt ? current : incoming;
  render([latest, ...currentRuns.filter((run) => run.id !== latest.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  return latest;
}
async function action(id, type) {
  if (pendingActions.has(id)) return false;
  pendingActions.set(id, type);
  updatePendingButtons();
  try {
    const updated = await checkedFetch(`/api/runs/${id}/${type}`, { method: "POST" }).then((response) => response.json());
    document.querySelector("#operation-error").hidden = true;
    document.querySelector("#detail-error").textContent = "";
    acceptRun(updated);
    const messages = {approve:"已批准实施", reject:"已拒绝写入", apply:"变更已应用到原仓库", discard:"变更已丢弃", cancel:"已请求取消", retry:"重试已加入队列", archive:"任务已归档", unarchive:"任务已恢复"};
    notify(messages[type] || "任务已更新", type === "archive" ? {action:{label:"撤销",run:()=>action(id,"unarchive")}} : {});
    return true;
  } finally { pendingActions.delete(id); updatePendingButtons(); }
}

function getRunAction(button) {
  if (button.dataset.runAction) return button.dataset.runAction;
  const operations = { approve: "approve", reject: "reject", apply: "apply", discard: "discard", "cancel-run": "cancel", "retry-run": "retry", "archive-run": button.dataset.action };
  return operations[Object.keys(operations).find((name) => button.classList.contains(name))];
}

function updatePendingButtons() {
  for (const root of [runsEl, runDialog]) root.querySelectorAll('button[data-id]').forEach((button) => {
    const operation = getRunAction(button);
    if (!operation) return;
    const run = currentRuns.find((item) => item.id === button.dataset.id);
    button.disabled = !runnerConnected || pendingActions.has(button.dataset.id) || Boolean(run?.starting && operation !== "cancel") || (loginBusy && ['approve', 'retry'].includes(operation));
    const busy = pendingActions.get(button.dataset.id) === operation;
    button.dataset.label ||= button.textContent;
    button.textContent = busy ? "处理中……" : button.dataset.label;
    button.setAttribute("aria-busy", String(busy));
  });
}

function setDetailTab(name, focus = false) {
  const changed = name !== detailTab;
  if (changed && runDialog.open) {
    detailTabViews.set(detailTab, {...captureView(runDialog), focus:null});
    if (detailTab === 'events') eventViewer.deactivate();
  }
  detailTab = name;
  runDialog.querySelectorAll('[data-detail-tab]').forEach((button) => {
    const selected = button.dataset.detailTab === name;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (focus && selected) button.focus();
  });
  runDialog.querySelectorAll('[data-tab-panel]').forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== name; });
  if (changed) {
    const previous = detailTabViews.get(name);
    if (previous) restoreView(runDialog, previous);
    else runDialog.scrollTop = 0;
  }
  if (name === 'events') eventViewer.activate();
}
runDialog.querySelector('[role="tablist"]').addEventListener('click', (event) => {
  const button = event.target.closest('[data-detail-tab]');
  if (button) setDetailTab(button.dataset.detailTab);
});
runDialog.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
  const names = ['overview','output','events','diff'];
  let index = names.indexOf(detailTab);
  if (event.key === 'ArrowRight') index = (index + 1) % names.length;
  else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = names.length - 1;
  else return;
  event.preventDefault(); setDetailTab(names[index], true);
});

function openRunDetail(run) {
  if (!run) return;
  const preserve = runDialog.open && detailRunId === run.id;
  if (!preserve) {
    detailTabViews.clear();
    detailTab = run.state === 'awaiting_merge' ? 'diff' : run.state === 'awaiting_approval' ? 'output' : 'overview';
    document.querySelector('#detail-error').textContent = '';
    document.querySelector('.workflow-history').open = false;
  }
  detailRunId = run.id;
  renderRunDetail(run, preserve);
  if (!runDialog.open) runDialog.showModal();
}

function detailActions(run) {
  const button = (op,label,primary=false) => `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-id="${escapeHtml(run.id)}" data-run-action="${op}">${label}</button>`;
  if (run.state === 'awaiting_approval') return button('reject','拒绝') + button('approve','批准并执行',true);
  if (run.state === 'awaiting_merge') return button('discard','丢弃变更') + button('apply','应用到原仓库',true);
  if (['running','queued','approved'].includes(run.state)) return button('cancel','取消任务');
  let actions = ['failed','cancelled','budget_exceeded'].includes(run.state) ? button('retry','重试任务',true) : '';
  if (terminalStates.has(run.state)) actions += button(run.archived?'unarchive':'archive',run.archived?'恢复任务':'归档任务') + button('delete','删除历史记录');
  return actions;
}

function renderRunDetail(run, preserve = true) {
  const previous = preserve ? captureView(runDialog) : null;
  const previousRun = renderedDetailRun;
  renderedDetailRun = run;
  const usage = run.usage || {};
  const nextSteps = {queued:'等待可用的执行名额。',running:'Codex 正在执行，可在“事件”标签页查看实时进度。',approved:'已批准实施，正在等待开始执行。',awaiting_approval:'先在“输出”中阅读分析方案，确认后点击“批准并执行”。',awaiting_merge:'先在“代码变更”中检查补丁，再决定是否应用到原仓库。',completed:'任务已完成，可在“输出”中查看结果。',failed:'查看错误与事件，解决问题后可重试任务。',cancelled:'任务已取消，可重试或归档。',budget_exceeded:'请在“设置”中调整预算后，再重试此任务。',discarded:'隔离工作区中的变更已丢弃。'};
  const title = document.querySelector('#detail-title');
  if (title.textContent !== run.prompt) title.textContent = run.prompt;
  updateMarkup(document.querySelector('#detail-overview-body'), `
    <p class="next-step">${escapeHtml(nextSteps[run.state] || '')}</p>
    <div class="detail-meta"><div><span>状态</span><strong class="status ${run.state}">${statusLabel[run.state]}</strong></div><div><span>项目</span><strong>${escapeHtml(projects.find((project) => project.id === run.projectId)?.name || "未登记")}</strong></div><div><span>仓库</span><strong title="${escapeHtml(run.repository)}">${escapeHtml(run.repository)}</strong></div><div><span>任务模式</span><strong>${run.mode === 'review' ? '只读审查' : '实施修改'}</strong></div></div>
    <div class="detail-usage"><div><span>Token 总量</span><strong>${formatTokens(usage.totalTokens)}</strong></div><div><span>输入 / 缓存</span><strong>${formatTokens(usage.inputTokens)} / ${formatTokens(usage.cachedInputTokens)}</strong></div><div><span>输出</span><strong>${formatTokens(usage.outputTokens)}</strong></div><div><span>运行时长</span><strong>${formatDuration(usage.durationMs)}</strong></div><div><span>模型</span><strong>${escapeHtml(usage.model || "—")}</strong></div></div>
    ${run.error ? `<p class="error">${escapeHtml(messageText(run.error))}</p>` : ''}
    <p class="detail-created">创建时间：${new Date(run.createdAt).toLocaleString('zh-CN')}</p>`);
  if (!previousRun || previousRun.output !== run.output || previousRun.mode !== run.mode) {
    document.querySelector('#detail-output-title').textContent = run.mode === 'review' ? '审查报告' : '执行结果';
    document.querySelector('[data-copy="output"]').disabled = !run.output;
    updateMarkup(document.querySelector('#detail-output-body'), run.output
      ? `<pre data-view="report">${escapeHtml(agentOutput(run.output))}</pre>`
      : '<p class="tab-empty">当前阶段完成后会显示报告，实时进度请查看“事件”。</p>');
  }
  updateMarkup(document.querySelector('#detail-timeline'), run.events.map((event) => `<article><i></i><time>${new Date(event.at).toLocaleString('zh-CN')}</time><div><strong title="${escapeHtml(event.type)}">${escapeHtml(eventLabel(event.type))}</strong><p>${escapeHtml(messageText(event.message))}</p></div></article>`).join(''));
  eventViewer.update(run);
  if (!previousRun || previousRun.diff !== run.diff || previousRun.diffStat !== run.diffStat || previousRun.mode !== run.mode) {
    document.querySelector('[data-copy="diff"]').disabled = !run.diff;
    updateMarkup(document.querySelector('#detail-diff-body'), run.diff
      ? `<p class="diff-summary">${escapeHtml(run.diffStat || '')}</p><pre class="diff" data-view="detail-diff">${run.diff.split('\n').map((line) => `<span class="${line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':line.startsWith('@@')?'diff-hunk':''}">${escapeHtml(line)}</span>`).join('\n')}</pre>`
      : `<p class="tab-empty">${run.mode === 'review' ? '只读审查不会生成修改补丁。' : '批准实施并产生文件修改后，这里会显示代码变更。'}</p>`);
  }
  const footer = document.querySelector('#detail-actions');
  updateMarkup(footer, detailActions(run));
  setDetailTab(detailTab);
  if (previous) restoreView(runDialog, previous);
  else runDialog.scrollTop = 0;
  updatePendingButtons();
}
runDialog.addEventListener("close", () => {
  detailRunId = null; renderedDetailRun = null; detailTabViews.clear();
  // A live update may have replaced the card that originally opened the dialog.
  if (!document.activeElement || document.activeElement === document.body) document.querySelector('#run-search').focus({preventScroll:true});
});

function runCard(run) {
  const isReview = run.mode === "review";
  const activeActions = ["queued", "running", "approved"].includes(run.state)
    ? `<button class="secondary danger cancel-run" data-id="${run.id}">取消任务</button>` : "";
  const retryAction = ["failed", "cancelled", "budget_exceeded"].includes(run.state)
    ? `<button class="secondary retry-run" data-id="${run.id}">重试${escapeHtml(phaseLabel(run.phase))}</button>` : "";
  const historyAction = terminalStates.has(run.state) ? `<button class="secondary archive-run" data-id="${run.id}" data-action="${run.archived ? "unarchive" : "archive"}">${run.archived ? "恢复" : "归档"}</button>` : "";
  const approval = run.state === "awaiting_approval" ? `
    <div class="approval-box">
      <div><strong>请求写入权限</strong><p>请先阅读分析方案，再批准修改隔离工作区。</p></div>
      <div><button class="secondary reject" data-id="${run.id}">拒绝</button><button class="primary approve" data-id="${run.id}">批准并执行</button></div>
    </div>` : "";
  const mergeApproval = run.state === "awaiting_merge" ? `
    <div class="diff-review">
      <div class="diff-title"><div><strong>变更位于隔离工作区</strong><p>${escapeHtml(run.diffStat || "应用前请先检查补丁。")}</p></div><span>尚未修改原仓库</span></div>
      <pre class="diff" data-view="diff">${escapeHtml(run.diff)}</pre>
      <div class="review-actions"><button class="secondary discard" data-id="${run.id}">丢弃变更</button><button class="primary apply" data-id="${run.id}">应用到原仓库</button></div>
    </div>` : "";
  return `<article class="run-card" data-run-id="${escapeHtml(run.id)}">
    <div class="run-head"><div><span class="status ${run.state}">${statusLabel[run.state]}</span><h3>${escapeHtml(run.prompt)}</h3></div><div class="run-controls"><button class="secondary detail-run" data-id="${run.id}">查看详情</button>${historyAction}${retryAction}${activeActions}<time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></div></div>
    <p class="repo"><span class="mode-label">${isReview ? "只读审查" : "实施修改"}</span> ⌘ ${escapeHtml(run.repository)}</p>
    <div class="steps"><span class="done">1</span><b></b><span class="${run.phase === "implementation" || run.state === "completed" ? "done" : "current"}">2</span><b></b><span class="${run.state === "completed" ? "done" : ""}">3</span></div>
    <div class="step-labels"><span>排队中</span><span>${isReview ? "审查" : "分析"}</span><span>${isReview ? "报告" : "实施"}</span></div>
    ${run.output ? `<details data-view="output-section" ${run.state === "awaiting_approval" || (isReview && run.state === "completed") ? "open" : ""}><summary>${isReview ? "审查报告" : "执行结果"}</summary><pre data-view="output">${escapeHtml(agentOutput(run.output))}</pre></details>` : ""}
    ${run.logs?.length ? `<details class="live-log" data-view="log-section" ${run.state === "running" ? "open" : ""}><summary><span class="pulse"></span> 实时事件（${run.logs.length}）</summary><div class="log-lines" data-view="logs" data-follow="true">${run.logs.slice(-100).map((log) => `<div><time>${new Date(log.at).toLocaleTimeString('zh-CN')}</time><b title="${escapeHtml(log.type)}">${escapeHtml(eventLabel(log.type))}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div></details>` : ""}
    ${run.error ? `<p class="error">${escapeHtml(messageText(run.error))}</p>` : ""}
    ${run.state === "queued" ? '<p class="queue-note">正在排队，等待空闲的并发名额。</p>' : ""}
    ${run.state === "budget_exceeded" ? `<p class="budget-alert">${escapeHtml(messageText(run.events.at(-1)?.message || "已达到预算上限"))}</p>` : ""}
    ${approval}
    ${mergeApproval}
  </article>`;
}

const updateRunList = createRunList(runsEl, runCard);
async function handleRunClick(event) {
  const copy = event.target.closest('button[data-copy]');
  if (copy && runDialog.contains(copy)) {
    const text = copy.dataset.copy === 'diff' ? renderedDetailRun?.diff : agentOutput(renderedDetailRun?.output || '');
    try { await navigator.clipboard.writeText(text || ''); notify(copy.dataset.copy === 'diff' ? '已复制补丁' : '已复制结果'); }
    catch { notify('无法访问剪贴板，请选中文本后手动复制。',{kind:'error'}); }
    return;
  }
  const button = event.target.closest("button[data-id]");
  if (!button || button.disabled) return;
  if (button.classList.contains("detail-run")) { openRunDetail(currentRuns.find((run) => run.id === button.dataset.id)); return; }
  const operation = getRunAction(button);
  if (!operation) return;
  if (operation === 'delete') {
    if (pendingActions.has(button.dataset.id) || !window.confirm('确认删除这条任务历史记录？原仓库文件会保留。')) return;
    const id = button.dataset.id;
    pendingActions.set(id,'delete'); updatePendingButtons();
    try { await checkedFetch(`/api/runs/${id}`,{method:'DELETE'}); render(currentRuns.filter((run) => run.id !== id)); notify('历史记录已删除'); }
    finally { pendingActions.delete(id); updatePendingButtons(); }
  } else await action(button.dataset.id,operation);
}
runsEl.addEventListener('click', handleRunClick);
runDialog.addEventListener('click', handleRunClick);

function render(runs) {
  currentRuns = runs;
  const visibleRuns = filteredRuns(runs);
  emptyEl.hidden = visibleRuns.length > 0;
  emptyEl.querySelector("h3").textContent = runs.length ? "没有匹配的任务" : "暂无任务";
  emptyEl.querySelector("p").textContent = runs.length ? "调整搜索条件或清除筛选，以查看其他任务。" : "新建任务后，Codex 会先进行只读分析。";
  updateRunList(visibleRuns.slice(0, visibleLimit));
  const countLabel = `显示 ${Math.min(visibleLimit, visibleRuns.length)} / ${visibleRuns.length} 个任务`;
  if (document.querySelector("#filter-count").textContent !== countLabel) document.querySelector("#filter-count").textContent = countLabel;
  document.querySelector("#load-more").hidden = visibleLimit >= visibleRuns.length;
  document.querySelector("#empty-action").textContent = runs.length ? "清除筛选" : projects.length ? "新建任务" : "添加项目";
  document.querySelector('#empty-action').dataset.action = runs.length ? 'clear' : 'create';
  const filtered = document.querySelector("#run-search").value || document.querySelector("#state-filter").value || document.querySelector("#project-filter").value || document.querySelector("#show-archived").checked;
  document.querySelector("#clear-filters").hidden = !filtered;
  if (runs.length && !runs.some((run) => !run.archived) && !filtered) {
    emptyEl.querySelector('h3').textContent = '所有任务均已归档';
    emptyEl.querySelector('p').textContent = '打开已归档任务，查看之前的工作。';
    document.querySelector('#empty-action').textContent = '查看已归档任务';
    document.querySelector('#empty-action').dataset.action = 'archived';
  }
  document.querySelectorAll('[data-quick-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.quickFilter === document.querySelector('#state-filter').value && !document.querySelector('#show-archived').checked)));
  const active = runs.filter((run) => !run.archived && ["queued", "running", "approved"].includes(run.state)).length;
  const approval = runs.filter((run) => !run.archived && ["awaiting_approval", "awaiting_merge"].includes(run.state)).length;
  document.querySelector("#active-runs").textContent = active;
  document.querySelector("#needs-approval").textContent = approval;
  document.querySelector("#approval-count").textContent = approval;
  document.querySelector("#completed-runs").textContent = runs.filter((run) => !run.archived && run.state === "completed").length;
  renderUsage(runs);
  if (runDialog.open && detailRunId) {
    const selected = runs.find((run) => run.id === detailRunId);
    if (!selected) runDialog.close();
    else if (selected !== renderedDetailRun) renderRunDetail(selected);
  }
  updatePendingButtons();
}

async function refresh() {
  render(await checkedFetch("/api/runs").then((r) => r.json()));
}

async function loadSettings() {
  const settings = await checkedFetch("/api/settings").then((response) => response.json());
  const settingsForm = document.querySelector("#budget-settings");
  if (settingsDirty || settingsForm.dataset.busy) return;
  for (const [key, value] of Object.entries(settings)) {
    if (settingsForm.elements[key]) settingsForm.elements[key].value = value;
  }
}

function renderCatalog() {
  const selectedProjectFilter = document.querySelector("#project-filter").value;
  document.querySelector("#project-list").innerHTML = projects.length ? projects.map((project) => `<article><div><strong>${escapeHtml(project.name)}</strong><p>${escapeHtml(project.repository)}</p><small>${escapeHtml(project.branch)}${project.remote ? ` · ${escapeHtml(project.remote)}` : ""}</small></div><button class="icon delete-project" data-id="${project.id}" title="移除项目登记">×</button></article>`).join("") : '<p class="catalog-empty">尚未添加项目。</p>';
  document.querySelector("#template-list").innerHTML = templates.map((template) => `<article><div><strong>${escapeHtml(template.name)}</strong>${template.builtIn ? '<span class="builtin">内置</span>' : ""}<p>${escapeHtml(template.description || "自定义任务模板")}</p></div>${template.builtIn ? "" : `<button class="icon delete-template" data-id="${template.id}" title="删除模板">×</button>`}</article>`).join("");
  document.querySelector("#project-filter").innerHTML = '<option value="">全部项目</option>' + projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  document.querySelector("#project-filter").value = projects.some((project) => project.id === selectedProjectFilter) ? selectedProjectFilter : '';
  composer.catalogChanged(projects, templates);
  onboarding.projectsChanged(projects);
  document.querySelectorAll(".delete-project").forEach((button) => button.addEventListener("click", async () => {
    await checkedFetch(`/api/projects/${button.dataset.id}`, { method: "DELETE" });
    await loadCatalog();
    notify("已移除项目登记");
  }));
  document.querySelectorAll(".delete-template").forEach((button) => button.addEventListener("click", async () => {
    await checkedFetch(`/api/templates/${button.dataset.id}`, { method: "DELETE" });
    await loadCatalog();
  }));
}

async function loadCatalog() {
  [projects, templates] = await Promise.all([
    checkedFetch("/api/projects").then((response) => response.json()),
    checkedFetch("/api/templates").then((response) => response.json()),
  ]);
  renderCatalog();
  render(currentRuns);
}

async function withBusyForm(target, work) {
  if (target.dataset.busy) return;
  target.dataset.busy = 'true'; target.setAttribute('aria-busy','true');
  const controls = [...target.querySelectorAll('button,input,textarea,select')];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  try { return await work(); }
  finally { controls.forEach((control,index) => { control.disabled = disabled[index]; }); delete target.dataset.busy; target.setAttribute('aria-busy','false'); }
}

async function submitCatalogForm(event, endpoint) {
  event.preventDefault();
  const target = event.currentTarget;
  const body = Object.fromEntries(new FormData(target));
  const message = target.querySelector('.form-message');
  await withBusyForm(target, async () => {
    message.textContent = '正在保存……';
    try {
      await checkedFetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      target.reset(); target.hidden = true; message.textContent = '';
      notify(endpoint === '/api/projects' ? '项目已添加' : '模板已保存');
      await loadCatalog();
    } catch (error) { message.textContent = error.message; }
  });
}

document.querySelector('#new-task').addEventListener('click', () => composer.open());
document.querySelector("#notification-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const popover = document.querySelector("#notification-popover");
  popover.hidden = !popover.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!popover.hidden));
});
document.querySelector("#notification-popover").addEventListener("click", (event) => event.stopPropagation());
function closeNotifications() {
  document.querySelector('#notification-popover').hidden = true;
  document.querySelector('#notification-button').setAttribute('aria-expanded','false');
}
document.addEventListener('click',closeNotifications);
document.querySelector("#mark-notifications-read").addEventListener("click", () => {
  notifications.forEach((item) => (item.read = true));
  writeLocal(notificationStorageKey, notifications);
  renderNotifications();
});
document.querySelector("#enable-system-notifications").addEventListener("click", async () => {
  if (window.Notification) await Notification.requestPermission();
  renderNotifications();
});
document.querySelectorAll("#notify-approvals,#notify-results").forEach((control) => control.addEventListener("change", () => {
  notificationPreferences = {
    approvals: document.querySelector("#notify-approvals").checked,
    results: document.querySelector("#notify-results").checked,
  };
  writeLocal(notificationPreferenceKey, notificationPreferences);
}));
document.querySelector("#close-run-dialog").addEventListener("click", () => runDialog.close());
function syncNavigation() {
  const approvals = currentSection === 'runs-panel' && document.querySelector('#state-filter').value === 'approvals' && !document.querySelector('#show-archived').checked;
  document.querySelectorAll('.nav').forEach((button) => {
    const active = approvals ? button.id === 'approvals-nav' || button.dataset.filterNav === 'approvals' : button.dataset.target === currentSection;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','location'); else button.removeAttribute('aria-current');
  });
}
function navigate(target) {
  currentSection = target;
  syncNavigation();
  const section = document.querySelector(`#${target}`);
  if (section) {
    section.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    section.tabIndex = -1; section.focus({preventScroll:true});
  }
}

document.querySelectorAll('.nav[data-target]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.target === 'runs-panel') clearFilters();
  navigate(button.dataset.target);
}));
document.querySelector('#budget-settings').addEventListener('input', () => { settingsDirty = true; });
document.querySelector('#budget-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = event.currentTarget;
  const body = Object.fromEntries([...new FormData(target)].map(([key,value]) => [key,Number(value)]));
  const status = document.querySelector('#settings-status');
  await withBusyForm(target, async () => {
    status.textContent = '正在保存……';
    try {
      await checkedFetch('/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      settingsDirty = false; status.textContent = '设置已保存'; notify('预算设置已保存');
    } catch (error) { status.textContent = error.message; }
  });
});
document.querySelector("#show-project-form").addEventListener("click", () => (document.querySelector("#project-form").hidden = false));
document.querySelector("#show-template-form").addEventListener("click", () => (document.querySelector("#template-form").hidden = false));
document.querySelectorAll(".form-cancel").forEach((button) => button.addEventListener("click", () => (button.closest("form").hidden = true)));
function filterChanged() { visibleLimit = 20; currentSection = 'runs-panel'; syncNavigation(); render(currentRuns); }
function clearFilters() {
  document.querySelector('#run-search').value = ''; document.querySelector('#state-filter').value = ''; document.querySelector('#project-filter').value = ''; document.querySelector('#show-archived').checked = false; filterChanged();
}
function filterBy(state) { clearFilters(); document.querySelector('#state-filter').value = state; filterChanged(); navigate('runs-panel'); }
document.querySelectorAll('#run-search,#state-filter,#project-filter,#show-archived').forEach((control) => control.addEventListener('input',filterChanged));
document.querySelectorAll('[data-quick-filter]').forEach((button) => button.addEventListener('click', () => { document.querySelector('#state-filter').value=button.dataset.quickFilter; document.querySelector('#show-archived').checked=false; filterChanged(); }));
document.querySelectorAll('[data-filter-nav]').forEach((button) => button.addEventListener('click', () => filterBy(button.dataset.filterNav)));
document.querySelector('#clear-filters').addEventListener('click',clearFilters);
document.querySelector('#empty-action').addEventListener('click', () => {
  if (!currentRuns.length) composer.open();
  else if (document.querySelector('#empty-action').dataset.action === 'archived') { document.querySelector('#show-archived').checked = true; filterChanged(); }
  else clearFilters();
});
document.querySelector('#load-more').addEventListener('click', () => { visibleLimit += 20; render(currentRuns); });
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.repeat) return;
  if (event.key === 'Escape' && !dialog.open && !runDialog.open && !document.querySelector('#notification-popover').hidden) {
    closeNotifications(); document.querySelector('#notification-button').focus(); event.preventDefault(); return;
  }
  if (dialog.open) { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); composer.submit(); } return; }
  if (runDialog.open || event.metaKey || event.ctrlKey || event.altKey || event.target.isContentEditable || event.target.closest?.('input,textarea,select')) return;
  if (event.key === '/') { event.preventDefault(); navigate('runs-panel'); document.querySelector('#run-search').focus({preventScroll:true}); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); composer.open(); }
});
document.querySelector("#project-form").addEventListener("submit", (event) => submitCatalogForm(event, "/api/projects"));
document.querySelector("#template-form").addEventListener("submit", (event) => submitCatalogForm(event, "/api/templates"));

let installPrompt = null;
const installButton = document.querySelector("#install-app");
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installButton.hidden = true;
});

function connectionStatus(connected) {
  runnerConnected = connected;
  composer.connectionChanged(connected && !loginBusy);
  onboarding.connectionChanged(connected);
  updatePendingButtons();
  const status = document.querySelector(".local-status");
  status.classList.toggle("disconnected", !connected);
  status.querySelector("small").textContent = connected ? "已连接" : "正在重连……";
  document.querySelector("#connection-banner").hidden = connected;
  document.querySelector("#new-task").disabled = !connected || loginBusy;
}

function showUpdate(registration) {
  if (!registration.waiting || document.querySelector(".update-toast")) return;
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.innerHTML = '<span>控制台更新已就绪</span><button class="primary" type="button">重新加载</button>';
  toast.querySelector("button").addEventListener("click", () => {
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
    registration.waiting?.postMessage({ type: "skip-waiting" });
  });
  document.body.append(toast);
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").then((registration) => {
    showUpdate(registration);
    registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => showUpdate(registration)));
  }).catch(() => {});
}

connectionStatus(false);
syncNavigation();
renderNotifications();
const events = new EventSource("/api/events");
events.addEventListener('auth', event => onboarding.accept(JSON.parse(event.data)));
events.onopen = () => {
  connectionStatus(true);
  void Promise.all([loadSettings(), loadCatalog(), environment.refresh()]).catch(() => {});
};
events.addEventListener("snapshot", (event) => {
  const snapshot = JSON.parse(event.data);
  for (const run of snapshot) addNotification(notificationForTransition(currentRuns.find((item) => item.id === run.id), run));
  snapshot.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  render(snapshot);
});
events.addEventListener("run", (event) => {
  const changed = JSON.parse(event.data);
  const previous = currentRuns.find((run) => run.id === changed.id);
  const next = currentRuns.filter((run) => run.id !== changed.id);
  next.push(changed);
  next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  render(next);
  addNotification(notificationForTransition(previous, changed));
});
events.onerror = () => {
  connectionStatus(false);
};

document.querySelector('#approvals-nav').addEventListener('click', () => filterBy('approvals'));
