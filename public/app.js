const runsEl = document.querySelector("#runs");
const emptyEl = document.querySelector("#empty");
const dialog = document.querySelector("#task-dialog");
const form = document.querySelector("#task-form");
let currentRuns = [];
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
};

const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

async function action(id, type) {
  await fetch(`/api/runs/${id}/${type}`, { method: "POST" });
  await refresh();
}

function runCard(run) {
  const activeActions = ["queued", "running", "approved"].includes(run.state)
    ? `<button class="secondary danger cancel-run" data-id="${run.id}">Cancel run</button>` : "";
  const retryAction = ["failed", "cancelled"].includes(run.state)
    ? `<button class="secondary retry-run" data-id="${run.id}">Retry ${run.phase}</button>` : "";
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
    <div class="run-head"><div><span class="status ${run.state}">${statusLabel[run.state]}</span><h3>${escapeHtml(run.prompt)}</h3></div><div class="run-controls">${retryAction}${activeActions}<time>${new Date(run.createdAt).toLocaleString()}</time></div></div>
    <p class="repo">⌘ ${escapeHtml(run.repository)}</p>
    <div class="steps"><span class="done">1</span><b></b><span class="${run.phase === "implementation" ? "done" : "current"}">2</span><b></b><span class="${run.state === "completed" ? "done" : ""}">3</span></div>
    <div class="step-labels"><span>Queued</span><span>Analyze</span><span>Implement</span></div>
    ${run.output ? `<details ${run.state === "awaiting_approval" ? "open" : ""}><summary>Agent output</summary><pre>${escapeHtml(run.output)}</pre></details>` : ""}
    ${run.logs?.length ? `<details class="live-log" ${run.state === "running" ? "open" : ""}><summary><span class="pulse"></span> Live events (${run.logs.length})</summary><div class="log-lines">${run.logs.slice(-100).map((log) => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.type)}</b><span>${escapeHtml(log.message)}</span></div>`).join("")}</div></details>` : ""}
    ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ""}
    ${approval}
    ${mergeApproval}
  </article>`;
}

function render(runs) {
  currentRuns = runs;
  emptyEl.hidden = runs.length > 0;
  runsEl.innerHTML = runs.map(runCard).join("");
  const active = runs.filter((run) => ["queued", "running", "approved"].includes(run.state)).length;
  const approval = runs.filter((run) => ["awaiting_approval", "awaiting_merge"].includes(run.state)).length;
  document.querySelector("#active-runs").textContent = active;
  document.querySelector("#needs-approval").textContent = approval;
  document.querySelector("#approval-count").textContent = approval;
  document.querySelector("#completed-runs").textContent = runs.filter((run) => run.state === "completed").length;
  document.querySelectorAll(".approve").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "approve")));
  document.querySelectorAll(".reject").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "reject")));
  document.querySelectorAll(".apply").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "apply")));
  document.querySelectorAll(".discard").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "discard")));
  document.querySelectorAll(".cancel-run").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "cancel")));
  document.querySelectorAll(".retry-run").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "retry")));
}

async function refresh() {
  render(await fetch("/api/runs").then((r) => r.json()));
}

document.querySelector("#new-task").addEventListener("click", () => dialog.showModal());
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
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

await refresh();
const events = new EventSource("/api/events");
events.addEventListener("run", (event) => {
  const changed = JSON.parse(event.data);
  const next = currentRuns.filter((run) => run.id !== changed.id);
  next.push(changed);
  next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  render(next);
});
events.onerror = () => setTimeout(refresh, 2000);
