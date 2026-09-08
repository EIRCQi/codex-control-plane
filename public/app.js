import { setupTaskComposer } from "./task-composer.js";
import { notify } from "./feedback.js";
import { captureView, restoreView, createRunList } from "./live-view.js";
import { setupEnvironment } from "./environment.js";
import { agentOutput } from "./run-output.js";
import { notificationForTransition } from "./notifications.js";

const runsEl = document.querySelector("#runs");
const emptyEl = document.querySelector("#empty");
const dialog = document.querySelector("#task-dialog");
const runDialog = document.querySelector("#run-dialog");
let currentRuns = [];
let runnerConnected = false;
let visibleLimit = 20;
let detailTab = "overview";
let settingsDirty = false;
let detailRunId = null;
let renderedDetailRun = null;
let projects = [];
let templates = [];
const notificationStorageKey = "codex-control-plane.notifications.v1";
const notificationPreferenceKey = "codex-control-plane.notification-preferences.v1";
let notifications = readLocal(notificationStorageKey, []);
let notificationPreferences = readLocal(notificationPreferenceKey, { approvals: true, results: true });
if (!Array.isArray(notifications)) notifications = [];
if (!notificationPreferences || typeof notificationPreferences !== "object") notificationPreferences = { approvals: true, results: true };
const statusLabel = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Approval required",
  awaiting_merge: "Review changes",
  approved: "Approved",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  discarded: "Discarded",
  budget_exceeded: "Budget stopped",
};

const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatTokens = (value = 0) => Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatDuration = (ms = 0) => ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
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
      <i></i><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.task)}</p><time>${new Date(item.at).toLocaleString()}</time></div>
    </button>`).join("") : '<p class="notification-empty">No notifications yet.</p>';
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
  document.querySelector("#notification-permission-status").textContent = permission === "granted" ? "Desktop alerts enabled" : permission === "denied" ? "Desktop alerts blocked by browser" : permission === "unsupported" ? "Desktop alerts are not supported" : "Permission not requested";
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
  document.querySelector("#cached-tokens").textContent = `${formatTokens(total.cached)} cached`;
  document.querySelector("#output-tokens").textContent = formatTokens(total.output);
  document.querySelector("#agent-time").textContent = formatDuration(total.duration);
  const denominator = Math.max(1, total.input + total.output);
  document.querySelector("#input-bar").style.width = `${(Math.max(0, total.input - total.cached) / denominator) * 100}%`;
  document.querySelector("#cached-bar").style.width = `${(total.cached / denominator) * 100}%`;
  document.querySelector("#output-bar").style.width = `${(total.output / denominator) * 100}%`;
  const models = Object.entries(total.models).sort((a, b) => b[1] - a[1]);
  document.querySelector("#model-list").innerHTML = models.length ? models.map(([model, tokens]) => `<div><span>${escapeHtml(model)}</span><strong>${formatTokens(tokens)} tokens</strong></div>`).join("") : "<p>No model data yet</p>";
  const rows = runs.filter((run) => run.usage?.totalTokens || run.usage?.durationMs).map((run) => `<tr><td title="${escapeHtml(run.prompt)}">${escapeHtml(run.prompt.slice(0, 42))}</td><td>${escapeHtml(run.usage.model || "—")}</td><td>${formatTokens(run.usage.inputTokens)}</td><td>${formatTokens(run.usage.cachedInputTokens)}</td><td>${formatTokens(run.usage.outputTokens)}</td><td><strong>${formatTokens(run.usage.totalTokens)}</strong></td><td>${formatDuration(run.usage.durationMs)}</td></tr>`).join("");
  document.querySelector("#usage-rows").innerHTML = rows || '<tr><td colspan="7" class="no-usage">Usage appears after the first Codex response completes.</td></tr>';
}

function showError(message) {
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
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    if (options?.method && !['GET','HEAD'].includes(options.method.toUpperCase())) {
      document.querySelector('#operation-error').hidden = true;
      if (runDialog.open) document.querySelector('#detail-error').textContent = '';
    }
    return response;
  } catch (error) {
    showError(error.message === "Failed to fetch" ? "Runner unavailable. Start it, then try again." : error.message);
    throw error;
  }
}
window.addEventListener("unhandledrejection", (event) => {
  showError(event.reason?.message || "Operation failed. Please try again.");
  event.preventDefault();
});
const environment = setupEnvironment({ request: checkedFetch, escapeHtml });
document.querySelector("#dismiss-error").addEventListener("click", () => { document.querySelector("#operation-error").hidden = true; });
const composer = setupTaskComposer({
  request: checkedFetch, escapeHtml, notify,
  onNeedProject: () => {
    const projectForm = document.querySelector("#project-form");
    projectForm.hidden = false; navigate("catalog-panel"); projectForm.elements.name.focus();
    notify("Register a local repository to create your first task");
  },
  onCreated: async (created) => {
    clearFilters();
    openRunDetail(acceptRun(created));
  },
});
const pendingActions = new Map();
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
    const messages = {approve:"Implementation approved", reject:"Write request rejected", apply:"Changes applied to the repository", discard:"Changes discarded", cancel:"Cancellation requested", retry:"Retry queued", archive:"Task archived", unarchive:"Task restored"};
    notify(messages[type] || "Task updated", type === "archive" ? {action:{label:"Undo",run:()=>action(id,"unarchive")}} : {});
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
    button.disabled = !runnerConnected || pendingActions.has(button.dataset.id) || Boolean(run?.starting && operation !== "cancel");
    const busy = pendingActions.get(button.dataset.id) === operation;
    button.dataset.label ||= button.textContent;
    button.textContent = busy ? "Working…" : button.dataset.label;
    button.setAttribute("aria-busy", String(busy));
  });
}

function setDetailTab(name, focus = false) {
  detailTab = name;
  runDialog.querySelectorAll('[data-detail-tab]').forEach((button) => {
    const selected = button.dataset.detailTab === name;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (focus && selected) button.focus();
  });
  runDialog.querySelectorAll('[data-tab-panel]').forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== name; });
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
  if (!preserve) { detailTab = run.state === 'awaiting_merge' ? 'diff' : run.state === 'awaiting_approval' ? 'output' : 'overview'; document.querySelector('#detail-error').textContent = ''; }
  detailRunId = run.id;
  renderRunDetail(run, preserve);
  if (!runDialog.open) runDialog.showModal();
}

function detailActions(run) {
  const button = (op,label,primary=false) => `<button type="button" class="${primary ? 'primary' : 'secondary'}" data-id="${escapeHtml(run.id)}" data-run-action="${op}">${label}</button>`;
  if (run.state === 'awaiting_approval') return button('reject','Reject') + button('approve','Approve & run',true);
  if (run.state === 'awaiting_merge') return button('discard','Discard changes') + button('apply','Apply to repository',true);
  if (['running','queued','approved'].includes(run.state)) return button('cancel','Cancel run');
  let actions = ['failed','cancelled','budget_exceeded'].includes(run.state) ? button('retry','Retry task',true) : '';
  if (terminalStates.has(run.state)) actions += button(run.archived?'unarchive':'archive',run.archived?'Restore task':'Archive task') + button('delete','Delete history');
  return actions;
}

function renderRunDetail(run, preserve = true) {
  const previous = preserve ? captureView(runDialog) : null;
  renderedDetailRun = run;
  const usage = run.usage || {};
  const nextSteps = {queued:'Waiting for an available execution slot.',running:'Codex is working. Follow its progress in Events.',approved:'Implementation is approved and waiting to start.',awaiting_approval:'Read the analysis in Output, then approve implementation when you are ready.',awaiting_merge:'Review the Diff tab before applying these changes to your repository.',completed:'The task is complete. Read the result in Output.',failed:'Review the error and events, then retry when the issue is resolved.',cancelled:'This task was cancelled. You can retry or archive it.',budget_exceeded:'Update your budget in Settings before retrying this task.',discarded:'The isolated changes have been discarded.'};
  document.querySelector("#detail-title").textContent = run.prompt;
  document.querySelector("#run-detail").innerHTML = `
    <section id="detail-overview" data-tab-panel="overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
      <p class="next-step">${escapeHtml(nextSteps[run.state] || '')}</p>
      <div class="detail-meta"><div><span>Status</span><strong class="status ${run.state}">${statusLabel[run.state]}</strong></div><div><span>Project</span><strong>${escapeHtml(projects.find((project) => project.id === run.projectId)?.name || "Unregistered")}</strong></div><div><span>Repository</span><strong title="${escapeHtml(run.repository)}">${escapeHtml(run.repository)}</strong></div><div><span>Task mode</span><strong>${run.mode === 'review' ? 'Read-only review' : 'Implementation'}</strong></div></div>
      <div class="detail-usage"><div><span>Total tokens</span><strong>${formatTokens(usage.totalTokens)}</strong></div><div><span>Input / cached</span><strong>${formatTokens(usage.inputTokens)} / ${formatTokens(usage.cachedInputTokens)}</strong></div><div><span>Output</span><strong>${formatTokens(usage.outputTokens)}</strong></div><div><span>Runtime</span><strong>${formatDuration(usage.durationMs)}</strong></div><div><span>Model</span><strong>${escapeHtml(usage.model || "—")}</strong></div></div>
      ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ''}
      <p class="detail-created">Created ${new Date(run.createdAt).toLocaleString()}</p>
    </section>
    <section id="detail-output" data-tab-panel="output" role="tabpanel" aria-labelledby="tab-output" tabindex="0">
      <div class="content-toolbar"><h3>${run.mode === 'review' ? 'Review report' : 'Agent output'}</h3><button type="button" class="secondary" data-copy="output" ${run.output?'':'disabled'}>Copy output</button></div>
      ${run.output ? `<pre data-view="report">${escapeHtml(agentOutput(run.output))}</pre>` : '<p class="tab-empty">The report will appear when this phase completes. Follow live progress in Events.</p>'}
    </section>
    <section id="detail-events" data-tab-panel="events" role="tabpanel" aria-labelledby="tab-events" tabindex="0">
      <h3>Workflow timeline</h3><div class="timeline">${run.events.map((event) => `<article><i></i><time>${new Date(event.at).toLocaleString()}</time><div><strong>${escapeHtml(event.type)}</strong><p>${escapeHtml(event.message)}</p></div></article>`).join("")}</div>
      <div class="content-toolbar"><h3>Codex events · ${run.logs?.length || 0}</h3></div>
      ${run.logs?.length ? `<div class="log-lines detail-logs" data-view="detail-logs" data-follow="true">${run.logs.map((log) => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.type)}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div>` : '<p class="tab-empty">No Codex events yet.</p>'}
    </section>
    <section id="detail-diff" data-tab-panel="diff" role="tabpanel" aria-labelledby="tab-diff" tabindex="0">
      <div class="content-toolbar"><h3>Proposed changes</h3><button type="button" class="secondary" data-copy="diff" ${run.diff?'':'disabled'}>Copy patch</button></div>
      ${run.diff ? `<p class="diff-summary">${escapeHtml(run.diffStat || '')}</p><pre class="diff" data-view="detail-diff">${run.diff.split('\n').map((line) => `<span class="${line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':line.startsWith('@@')?'diff-hunk':''}">${escapeHtml(line)}</span>`).join('\n')}</pre>` : `<p class="tab-empty">${run.mode === 'review' ? 'Read-only reviews do not produce a patch.' : 'A diff appears here after approved implementation produces changes.'}</p>`}
    </section>`;
  const footer = document.querySelector('#detail-actions');
  const markup = detailActions(run);
  if (footer.dataset.markup !== markup) { footer.innerHTML = markup; footer.dataset.markup = markup; }
  setDetailTab(detailTab);
  if (previous) restoreView(runDialog, previous);
  else runDialog.scrollTop = 0;
  updatePendingButtons();
}
runDialog.addEventListener("close", () => { detailRunId = null; renderedDetailRun = null; });

function runCard(run) {
  const isReview = run.mode === "review";
  const activeActions = ["queued", "running", "approved"].includes(run.state)
    ? `<button class="secondary danger cancel-run" data-id="${run.id}">Cancel run</button>` : "";
  const retryAction = ["failed", "cancelled", "budget_exceeded"].includes(run.state)
    ? `<button class="secondary retry-run" data-id="${run.id}">Retry ${run.phase}</button>` : "";
  const historyAction = terminalStates.has(run.state) ? `<button class="secondary archive-run" data-id="${run.id}" data-action="${run.archived ? "unarchive" : "archive"}">${run.archived ? "Restore" : "Archive"}</button>` : "";
  const approval = run.state === "awaiting_approval" ? `
    <div class="approval-box">
      <div><strong>Write access requested</strong><p>Review the analysis before allowing workspace changes.</p></div>
      <div><button class="secondary reject" data-id="${run.id}">Reject</button><button class="primary approve" data-id="${run.id}">Approve & run</button></div>
    </div>` : "";
  const mergeApproval = run.state === "awaiting_merge" ? `
    <div class="diff-review">
      <div class="diff-title"><div><strong>Changes are isolated</strong><p>${escapeHtml(run.diffStat || "Review the patch before applying it.")}</p></div><span>Original repo untouched</span></div>
      <pre class="diff" data-view="diff">${escapeHtml(run.diff)}</pre>
      <div class="review-actions"><button class="secondary discard" data-id="${run.id}">Discard changes</button><button class="primary apply" data-id="${run.id}">Apply to repository</button></div>
    </div>` : "";
  return `<article class="run-card" data-run-id="${escapeHtml(run.id)}">
    <div class="run-head"><div><span class="status ${run.state}">${statusLabel[run.state]}</span><h3>${escapeHtml(run.prompt)}</h3></div><div class="run-controls"><button class="secondary detail-run" data-id="${run.id}">Details</button>${historyAction}${retryAction}${activeActions}<time>${new Date(run.createdAt).toLocaleString()}</time></div></div>
    <p class="repo"><span class="mode-label">${isReview ? "Read-only review" : "Implementation"}</span> ⌘ ${escapeHtml(run.repository)}</p>
    <div class="steps"><span class="done">1</span><b></b><span class="${run.phase === "implementation" || run.state === "completed" ? "done" : "current"}">2</span><b></b><span class="${run.state === "completed" ? "done" : ""}">3</span></div>
    <div class="step-labels"><span>Queued</span><span>${isReview ? "Review" : "Analyze"}</span><span>${isReview ? "Report" : "Implement"}</span></div>
    ${run.output ? `<details data-view="output-section" ${run.state === "awaiting_approval" || (isReview && run.state === "completed") ? "open" : ""}><summary>${isReview ? "Review report" : "Agent output"}</summary><pre data-view="output">${escapeHtml(agentOutput(run.output))}</pre></details>` : ""}
    ${run.logs?.length ? `<details class="live-log" data-view="log-section" ${run.state === "running" ? "open" : ""}><summary><span class="pulse"></span> Live events (${run.logs.length})</summary><div class="log-lines" data-view="logs" data-follow="true">${run.logs.slice(-100).map((log) => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.type)}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div></details>` : ""}
    ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ""}
    ${run.state === "queued" ? '<p class="queue-note">Waiting for an available concurrency slot.</p>' : ""}
    ${run.state === "budget_exceeded" ? `<p class="budget-alert">${escapeHtml(run.events.at(-1)?.message || "Budget limit exceeded")}</p>` : ""}
    ${approval}
    ${mergeApproval}
  </article>`;
}

const updateRunList = createRunList(runsEl, runCard);
async function handleRunClick(event) {
  const copy = event.target.closest('button[data-copy]');
  if (copy && runDialog.contains(copy)) {
    const text = copy.dataset.copy === 'diff' ? renderedDetailRun?.diff : agentOutput(renderedDetailRun?.output || '');
    try { await navigator.clipboard.writeText(text || ''); notify(copy.dataset.copy === 'diff' ? 'Patch copied' : 'Output copied'); }
    catch { notify('Clipboard is unavailable. Select the text and copy it manually.',{kind:'error'}); }
    return;
  }
  const button = event.target.closest("button[data-id]");
  if (!button || button.disabled) return;
  if (button.classList.contains("detail-run")) { openRunDetail(currentRuns.find((run) => run.id === button.dataset.id)); return; }
  const operation = getRunAction(button);
  if (!operation) return;
  if (operation === 'delete') {
    if (pendingActions.has(button.dataset.id) || !window.confirm('Delete this task history record? Its repository files will be kept.')) return;
    const id = button.dataset.id;
    pendingActions.set(id,'delete'); updatePendingButtons();
    try { await checkedFetch(`/api/runs/${id}`,{method:'DELETE'}); render(currentRuns.filter((run) => run.id !== id)); notify('History record deleted'); }
    finally { pendingActions.delete(id); updatePendingButtons(); }
  } else await action(button.dataset.id,operation);
}
runsEl.addEventListener('click', handleRunClick);
runDialog.addEventListener('click', handleRunClick);

function render(runs) {
  currentRuns = runs;
  const visibleRuns = filteredRuns(runs);
  emptyEl.hidden = visibleRuns.length > 0;
  emptyEl.querySelector("h3").textContent = runs.length ? "No matching runs" : "No runs yet";
  emptyEl.querySelector("p").textContent = runs.length ? "Adjust the search or filters to see more history." : "Create a task to begin with read-only analysis.";
  updateRunList(visibleRuns.slice(0, visibleLimit));
  const countLabel = `${Math.min(visibleLimit, visibleRuns.length)} of ${visibleRuns.length} tasks`;
  if (document.querySelector("#filter-count").textContent !== countLabel) document.querySelector("#filter-count").textContent = countLabel;
  document.querySelector("#load-more").hidden = visibleLimit >= visibleRuns.length;
  document.querySelector("#empty-action").textContent = runs.length ? "Clear filters" : projects.length ? "Create a task" : "Register a project";
  const filtered = document.querySelector("#run-search").value || document.querySelector("#state-filter").value || document.querySelector("#project-filter").value || document.querySelector("#show-archived").checked;
  document.querySelector("#clear-filters").hidden = !filtered;
  if (runs.length && !runs.some((run) => !run.archived) && !filtered) {
    emptyEl.querySelector('h3').textContent = 'All tasks are archived';
    emptyEl.querySelector('p').textContent = 'Open archived history to review previous work.';
    document.querySelector('#empty-action').textContent = 'Show archived tasks';
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
  document.querySelector("#project-list").innerHTML = projects.length ? projects.map((project) => `<article><div><strong>${escapeHtml(project.name)}</strong><p>${escapeHtml(project.repository)}</p><small>${escapeHtml(project.branch)}${project.remote ? ` · ${escapeHtml(project.remote)}` : ""}</small></div><button class="icon delete-project" data-id="${project.id}" title="Remove registration">×</button></article>`).join("") : '<p class="catalog-empty">No projects registered yet.</p>';
  document.querySelector("#template-list").innerHTML = templates.map((template) => `<article><div><strong>${escapeHtml(template.name)}</strong>${template.builtIn ? '<span class="builtin">Built in</span>' : ""}<p>${escapeHtml(template.description || "Custom workflow template")}</p></div>${template.builtIn ? "" : `<button class="icon delete-template" data-id="${template.id}" title="Delete template">×</button>`}</article>`).join("");
  document.querySelector("#project-filter").innerHTML = '<option value="">All projects</option>' + projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  document.querySelector("#project-filter").value = projects.some((project) => project.id === selectedProjectFilter) ? selectedProjectFilter : '';
  composer.catalogChanged(projects, templates);
  document.querySelectorAll(".delete-project").forEach((button) => button.addEventListener("click", async () => {
    await checkedFetch(`/api/projects/${button.dataset.id}`, { method: "DELETE" });
    await loadCatalog();
    notify("Registration removed");
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
    message.textContent = 'Saving…';
    try {
      await checkedFetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      target.reset(); target.hidden = true; message.textContent = '';
      notify(endpoint === '/api/projects' ? 'Project registered' : 'Template saved');
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
function navigate(target) {
  const approvals = target === 'runs-panel' && document.querySelector('#state-filter').value === 'approvals';
  document.querySelectorAll('.nav').forEach((button) => {
    const active = approvals ? button.id === 'approvals-nav' || button.dataset.filterNav === 'approvals' : button.dataset.target === target;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','location'); else button.removeAttribute('aria-current');
  });
  const section = document.querySelector(`#${target}`);
  if (section) {
    section.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    section.tabIndex = -1; section.focus({preventScroll:true});
  }
}

document.querySelectorAll('.nav[data-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.target)));
document.querySelector('#budget-settings').addEventListener('input', () => { settingsDirty = true; });
document.querySelector('#budget-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = event.currentTarget;
  const body = Object.fromEntries([...new FormData(target)].map(([key,value]) => [key,Number(value)]));
  const status = document.querySelector('#settings-status');
  await withBusyForm(target, async () => {
    status.textContent = 'Saving…';
    try {
      await checkedFetch('/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      settingsDirty = false; status.textContent = 'Limits saved'; notify('Budget limits saved');
    } catch (error) { status.textContent = error.message; }
  });
});
document.querySelector("#show-project-form").addEventListener("click", () => (document.querySelector("#project-form").hidden = false));
document.querySelector("#show-template-form").addEventListener("click", () => (document.querySelector("#template-form").hidden = false));
document.querySelectorAll(".form-cancel").forEach((button) => button.addEventListener("click", () => (button.closest("form").hidden = true)));
function filterChanged() { visibleLimit = 20; render(currentRuns); }
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
  else if (document.querySelector('#empty-action').textContent === 'Show archived tasks') { document.querySelector('#show-archived').checked = true; filterChanged(); }
  else clearFilters();
});
document.querySelector('#load-more').addEventListener('click', () => { visibleLimit += 20; render(currentRuns); });
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.repeat) return;
  if (event.key === 'Escape' && !dialog.open && !runDialog.open && !document.querySelector('#notification-popover').hidden) {
    closeNotifications(); document.querySelector('#notification-button').focus(); event.preventDefault(); return;
  }
  if (dialog.open) { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); composer.submit(); } return; }
  if (runDialog.open || event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
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
  composer.connectionChanged(connected);
  updatePendingButtons();
  const status = document.querySelector(".local-status");
  status.classList.toggle("disconnected", !connected);
  status.querySelector("small").textContent = connected ? "Connected" : "Reconnecting…";
  document.querySelector("#connection-banner").hidden = connected;
  document.querySelector("#new-task").disabled = !connected;
}

function showUpdate(registration) {
  if (!registration.waiting || document.querySelector(".update-toast")) return;
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.innerHTML = '<span>Control Plane update ready</span><button class="primary" type="button">Reload</button>';
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
renderNotifications();
const events = new EventSource("/api/events");
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
