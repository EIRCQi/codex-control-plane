import { notificationForTransition } from "./notifications.js";

const runsEl = document.querySelector("#runs");
const emptyEl = document.querySelector("#empty");
const dialog = document.querySelector("#task-dialog");
const form = document.querySelector("#task-form");
const runDialog = document.querySelector("#run-dialog");
let currentRuns = [];
let projects = [];
let templates = [];
const notificationStorageKey = "codex-control-plane.notifications.v1";
const notificationPreferenceKey = "codex-control-plane.notification-preferences.v1";
let notifications = readLocal(notificationStorageKey, []);
let notificationPreferences = readLocal(notificationPreferenceKey, { approvals: true, results: true });
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
  localStorage.setItem(key, JSON.stringify(value));
}

function renderNotifications() {
  const unread = notifications.filter((item) => !item.read).length;
  const badge = document.querySelector("#notification-badge");
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : unread;
  document.querySelector("#notification-list").innerHTML = notifications.length ? notifications.map((item) => `
    <article class="${item.read ? "" : "unread"}" data-notification-id="${escapeHtml(item.id)}" data-run-id="${escapeHtml(item.runId)}">
      <i></i><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.task)}</p><time>${new Date(item.at).toLocaleString()}</time></div>
    </article>`).join("") : '<p class="notification-empty">No notifications yet.</p>';
  document.querySelectorAll("[data-notification-id]").forEach((item) => item.addEventListener("click", () => {
    const notification = notifications.find((entry) => entry.id === item.dataset.notificationId);
    if (notification) notification.read = true;
    writeLocal(notificationStorageKey, notifications);
    renderNotifications();
    document.querySelector("#notification-popover").hidden = true;
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
    const desktop = new Notification(notification.title, { body: notification.task, tag: notification.id });
    desktop.onclick = () => { window.focus(); const run = currentRuns.find((item) => item.id === notification.runId); if (run) openRunDetail(run); desktop.close(); };
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
    if (state && state !== "active" && run.state !== state) return false;
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

async function action(id, type) {
  await fetch(`/api/runs/${id}/${type}`, { method: "POST" });
  await refresh();
}

function openRunDetail(run) {
  const usage = run.usage || {};
  document.querySelector("#detail-title").textContent = run.prompt;
  document.querySelector("#run-detail").innerHTML = `
    <div class="detail-meta"><div><span>Status</span><strong class="status ${run.state}">${statusLabel[run.state]}</strong></div><div><span>Project</span><strong>${escapeHtml(projects.find((project) => project.id === run.projectId)?.name || "Unregistered")}</strong></div><div><span>Repository</span><strong>${escapeHtml(run.repository)}</strong></div><div><span>Created</span><strong>${new Date(run.createdAt).toLocaleString()}</strong></div></div>
    <div class="detail-usage"><div><span>Total tokens</span><strong>${formatTokens(usage.totalTokens)}</strong></div><div><span>Input / cached</span><strong>${formatTokens(usage.inputTokens)} / ${formatTokens(usage.cachedInputTokens)}</strong></div><div><span>Output</span><strong>${formatTokens(usage.outputTokens)}</strong></div><div><span>Runtime</span><strong>${formatDuration(usage.durationMs)}</strong></div><div><span>Model</span><strong>${escapeHtml(usage.model || "—")}</strong></div></div>
    <section class="detail-section"><h3>Event timeline</h3><div class="timeline">${run.events.map((event) => `<article><i></i><time>${new Date(event.at).toLocaleString()}</time><div><strong>${escapeHtml(event.type)}</strong><p>${escapeHtml(event.message)}</p></div></article>`).join("")}</div></section>
    ${run.logs?.length ? `<section class="detail-section"><h3>Codex events</h3><div class="log-lines detail-logs">${run.logs.map((log) => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.type)}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div></section>` : ""}
    ${run.diff ? `<section class="detail-section"><h3>Generated diff</h3><pre class="diff">${escapeHtml(run.diff)}</pre></section>` : ""}
    <div class="detail-actions">${terminalStates.has(run.state) ? `<button class="secondary detail-archive" data-id="${run.id}" data-action="${run.archived ? "unarchive" : "archive"}">${run.archived ? "Restore run" : "Archive run"}</button><button class="secondary danger delete-run" data-id="${run.id}">Delete history record</button>` : ""}</div>`;
  document.querySelector(".detail-archive")?.addEventListener("click", async (event) => {
    await action(event.currentTarget.dataset.id, event.currentTarget.dataset.action);
    runDialog.close();
  });
  document.querySelector(".delete-run")?.addEventListener("click", async (event) => {
    if (!window.confirm("Delete this control-plane history record? Repository files will not be touched.")) return;
    await fetch(`/api/runs/${event.currentTarget.dataset.id}`, { method: "DELETE" });
    runDialog.close();
    await refresh();
  });
  runDialog.showModal();
}

function runCard(run) {
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
      <pre class="diff">${escapeHtml(run.diff)}</pre>
      <div class="review-actions"><button class="secondary discard" data-id="${run.id}">Discard changes</button><button class="primary apply" data-id="${run.id}">Apply to repository</button></div>
    </div>` : "";
  return `<article class="run-card">
    <div class="run-head"><div><span class="status ${run.state}">${statusLabel[run.state]}</span><h3>${escapeHtml(run.prompt)}</h3></div><div class="run-controls"><button class="secondary detail-run" data-id="${run.id}">Details</button>${historyAction}${retryAction}${activeActions}<time>${new Date(run.createdAt).toLocaleString()}</time></div></div>
    <p class="repo">⌘ ${escapeHtml(run.repository)}</p>
    <div class="steps"><span class="done">1</span><b></b><span class="${run.phase === "implementation" ? "done" : "current"}">2</span><b></b><span class="${run.state === "completed" ? "done" : ""}">3</span></div>
    <div class="step-labels"><span>Queued</span><span>Analyze</span><span>Implement</span></div>
    ${run.output ? `<details ${run.state === "awaiting_approval" ? "open" : ""}><summary>Agent output</summary><pre>${escapeHtml(run.output)}</pre></details>` : ""}
    ${run.logs?.length ? `<details class="live-log" ${run.state === "running" ? "open" : ""}><summary><span class="pulse"></span> Live events (${run.logs.length})</summary><div class="log-lines">${run.logs.slice(-100).map((log) => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.type)}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div></details>` : ""}
    ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ""}
    ${run.state === "queued" ? '<p class="queue-note">Waiting for an available concurrency slot.</p>' : ""}
    ${run.state === "budget_exceeded" ? `<p class="budget-alert">${escapeHtml(run.events.at(-1)?.message || "Budget limit exceeded")}</p>` : ""}
    ${approval}
    ${mergeApproval}
  </article>`;
}

function render(runs) {
  currentRuns = runs;
  const visibleRuns = filteredRuns(runs);
  emptyEl.hidden = visibleRuns.length > 0;
  emptyEl.querySelector("h3").textContent = runs.length ? "No matching runs" : "No runs yet";
  emptyEl.querySelector("p").textContent = runs.length ? "Adjust the search or filters to see more history." : "Create a task to begin with read-only analysis.";
  runsEl.innerHTML = visibleRuns.map(runCard).join("");
  document.querySelector("#filter-count").textContent = `${visibleRuns.length} shown`;
  const active = runs.filter((run) => ["queued", "running", "approved"].includes(run.state)).length;
  const approval = runs.filter((run) => ["awaiting_approval", "awaiting_merge"].includes(run.state)).length;
  document.querySelector("#active-runs").textContent = active;
  document.querySelector("#needs-approval").textContent = approval;
  document.querySelector("#approval-count").textContent = approval;
  document.querySelector("#completed-runs").textContent = runs.filter((run) => run.state === "completed").length;
  renderUsage(runs);
  document.querySelectorAll(".approve").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "approve")));
  document.querySelectorAll(".reject").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "reject")));
  document.querySelectorAll(".apply").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "apply")));
  document.querySelectorAll(".discard").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "discard")));
  document.querySelectorAll(".cancel-run").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "cancel")));
  document.querySelectorAll(".retry-run").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "retry")));
  document.querySelectorAll(".archive-run").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, button.dataset.action)));
  document.querySelectorAll(".detail-run").forEach((button) => button.addEventListener("click", () => openRunDetail(runs.find((run) => run.id === button.dataset.id))));
}

async function refresh() {
  render(await fetch("/api/runs").then((r) => r.json()));
}

async function loadSettings() {
  const settings = await fetch("/api/settings").then((response) => response.json());
  const settingsForm = document.querySelector("#budget-settings");
  for (const [key, value] of Object.entries(settings)) {
    if (settingsForm.elements[key]) settingsForm.elements[key].value = value;
  }
}

function renderCatalog() {
  const selectedProjectFilter = document.querySelector("#project-filter").value;
  document.querySelector("#project-list").innerHTML = projects.length ? projects.map((project) => `<article><div><strong>${escapeHtml(project.name)}</strong><p>${escapeHtml(project.repository)}</p><small>${escapeHtml(project.branch)}${project.remote ? ` · ${escapeHtml(project.remote)}` : ""}</small></div><button class="icon delete-project" data-id="${project.id}" title="Remove registration">×</button></article>`).join("") : '<p class="catalog-empty">No projects registered yet.</p>';
  document.querySelector("#template-list").innerHTML = templates.map((template) => `<article><div><strong>${escapeHtml(template.name)}</strong>${template.builtIn ? '<span class="builtin">Built in</span>' : ""}<p>${escapeHtml(template.description || "Custom workflow template")}</p></div>${template.builtIn ? "" : `<button class="icon delete-template" data-id="${template.id}" title="Delete template">×</button>`}</article>`).join("");
  document.querySelector("#task-project").innerHTML = projects.length ? `<option value="">Choose project…</option>${projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)} · ${escapeHtml(project.branch)}</option>`).join("")}` : '<option value="">Register a project first</option>';
  document.querySelector("#task-template").innerHTML = '<option value="">No template</option>' + templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  document.querySelector("#project-filter").innerHTML = '<option value="">All projects</option>' + projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  document.querySelector("#project-filter").value = selectedProjectFilter;
  document.querySelectorAll(".delete-project").forEach((button) => button.addEventListener("click", async () => {
    await fetch(`/api/projects/${button.dataset.id}`, { method: "DELETE" });
    await loadCatalog();
  }));
  document.querySelectorAll(".delete-template").forEach((button) => button.addEventListener("click", async () => {
    await fetch(`/api/templates/${button.dataset.id}`, { method: "DELETE" });
    await loadCatalog();
  }));
}

async function loadCatalog() {
  [projects, templates] = await Promise.all([
    fetch("/api/projects").then((response) => response.json()),
    fetch("/api/templates").then((response) => response.json()),
  ]);
  renderCatalog();
}

async function submitCatalogForm(event, endpoint) {
  event.preventDefault();
  const form = event.currentTarget;
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  const message = form.querySelector(".form-message");
  if (!response.ok) return (message.textContent = (await response.json()).error);
  form.reset();
  form.hidden = true;
  message.textContent = "";
  await loadCatalog();
}

document.querySelector("#new-task").addEventListener("click", () => {
  if (!projects.length) {
    document.querySelector("#project-form").hidden = false;
    document.querySelector("#catalog-panel").scrollIntoView({ behavior: "smooth" });
    return;
  }
  dialog.showModal();
});
document.querySelector("#notification-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const popover = document.querySelector("#notification-popover");
  popover.hidden = !popover.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!popover.hidden));
});
document.querySelector("#notification-popover").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  document.querySelector("#notification-popover").hidden = true;
  document.querySelector("#notification-button").setAttribute("aria-expanded", "false");
});
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
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#close-run-dialog").addEventListener("click", () => runDialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
document.querySelectorAll(".nav[data-target]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".nav").forEach((nav) => nav.classList.remove("active"));
  button.classList.add("active");
  if (button.dataset.target === "top") window.scrollTo({ top: 0, behavior: "smooth" });
  else document.querySelector(`#${button.dataset.target}`)?.scrollIntoView({ behavior: "smooth" });
}));
document.querySelector("#budget-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const body = Object.fromEntries([...formData].map(([key, value]) => [key, Number(value)]));
  const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const status = document.querySelector("#settings-status");
  if (!response.ok) status.textContent = (await response.json()).error;
  else {
    status.textContent = "Limits saved";
    setTimeout(() => (status.textContent = ""), 2500);
  }
});
document.querySelector("#show-project-form").addEventListener("click", () => (document.querySelector("#project-form").hidden = false));
document.querySelector("#show-template-form").addEventListener("click", () => (document.querySelector("#template-form").hidden = false));
document.querySelectorAll(".form-cancel").forEach((button) => button.addEventListener("click", () => (button.closest("form").hidden = true)));
document.querySelectorAll("#run-search,#state-filter,#project-filter,#show-archived").forEach((control) => control.addEventListener("input", () => render(currentRuns)));
document.querySelector("#project-form").addEventListener("submit", (event) => submitCatalogForm(event, "/api/projects"));
document.querySelector("#template-form").addEventListener("submit", (event) => submitCatalogForm(event, "/api/templates"));
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#form-error");
  error.textContent = "";
  const body = Object.fromEntries(new FormData(form));
  const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) return (error.textContent = (await response.json()).error);
  form.reset();
  dialog.close();
  await refresh();
});

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
  const status = document.querySelector(".local-status");
  status.classList.toggle("disconnected", !connected);
  status.querySelector("small").textContent = connected ? "Connected" : "Reconnecting…";
}

function showUpdate(registration) {
  if (!registration.waiting || document.querySelector(".update-toast")) return;
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.innerHTML = '<span>Control Plane update ready</span><button class="primary" type="button">Reload</button>';
  toast.querySelector("button").addEventListener("click", () => {
    registration.waiting.postMessage({ type: "skip-waiting" });
    window.location.reload();
  });
  document.body.append(toast);
}

if ("serviceWorker" in navigator) {
  const registration = await navigator.serviceWorker.register("/sw.js");
  showUpdate(registration);
  registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => showUpdate(registration)));
}

await refresh();
await loadSettings();
await loadCatalog();
renderNotifications();
const events = new EventSource("/api/events");
events.onopen = () => connectionStatus(true);
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
  setTimeout(() => void refresh().catch(() => {}), 2000);
};
