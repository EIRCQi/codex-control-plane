const runsEl = document.querySelector("#runs");
const emptyEl = document.querySelector("#empty");
const dialog = document.querySelector("#task-dialog");
const form = document.querySelector("#task-form");
const statusLabel = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Approval required",
  approved: "Approved",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

async function action(id, type) {
  await fetch(`/api/runs/${id}/${type}`, { method: "POST" });
  await refresh();
}

function runCard(run) {
  const approval = run.state === "awaiting_approval" ? `
    <div class="approval-box">
      <div><strong>Write access requested</strong><p>Review the analysis before allowing workspace changes.</p></div>
      <div><button class="secondary reject" data-id="${run.id}">Reject</button><button class="primary approve" data-id="${run.id}">Approve & run</button></div>
    </div>` : "";
  return `<article class="run-card">
    <div class="run-head"><div><span class="status ${run.state}">${statusLabel[run.state]}</span><h3>${escapeHtml(run.prompt)}</h3></div><time>${new Date(run.createdAt).toLocaleString()}</time></div>
    <p class="repo">⌘ ${escapeHtml(run.repository)}</p>
    <div class="steps"><span class="done">1</span><b></b><span class="${run.phase === "implementation" ? "done" : "current"}">2</span><b></b><span class="${run.state === "completed" ? "done" : ""}">3</span></div>
    <div class="step-labels"><span>Queued</span><span>Analyze</span><span>Implement</span></div>
    ${run.output ? `<details ${run.state === "awaiting_approval" ? "open" : ""}><summary>Agent output</summary><pre>${escapeHtml(run.output)}</pre></details>` : ""}
    ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ""}
    ${approval}
  </article>`;
}

async function refresh() {
  const runs = await fetch("/api/runs").then((r) => r.json());
  emptyEl.hidden = runs.length > 0;
  runsEl.innerHTML = runs.map(runCard).join("");
  const active = runs.filter((run) => ["queued", "running", "approved"].includes(run.state)).length;
  const approval = runs.filter((run) => run.state === "awaiting_approval").length;
  document.querySelector("#active-runs").textContent = active;
  document.querySelector("#needs-approval").textContent = approval;
  document.querySelector("#approval-count").textContent = approval;
  document.querySelector("#completed-runs").textContent = runs.filter((run) => run.state === "completed").length;
  document.querySelectorAll(".approve").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "approve")));
  document.querySelectorAll(".reject").forEach((button) => button.addEventListener("click", () => action(button.dataset.id, "reject")));
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
setInterval(refresh, 2500);
