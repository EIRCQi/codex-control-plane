import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRun, approveRun, cancelRun, createRun, discardRun, exceedBudget, prepareRetry, rejectRun, requestMergeApproval, requestWriteApproval, terminalStates, transition } from "./lib/workflow.mjs";
import { addDuration, aggregateUsage, emptyUsage, recordUsage } from "./lib/usage.mjs";
import { builtInTemplates, createProject, createTemplate, renderTemplate } from "./lib/catalog.mjs";
import { saveJson, loadJson } from "./lib/storage.mjs";
import { startupErrorMessage } from "./lib/startup.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = process.env.CODEX_CONTROL_PLANE_DATA_DIR || path.join(root, ".codex-control-plane");
const dataFile = path.join(dataDir, "runs.json");
const settingsFile = path.join(dataDir, "settings.json");
const projectsFile = path.join(dataDir, "projects.json");
const templatesFile = path.join(dataDir, "templates.json");
const port = Number(process.env.PORT || 4310);
const worktreeRoot = path.join(os.tmpdir(), "codex-control-plane-worktrees");
const runs = new Map();
const processes = new Map();
const eventClients = new Set();
const projects = new Map();
const actionLocks = new Set();
const jobs = new Set();
let ready = false;
let stopping = false;
let customTemplates = [];
const defaultSettings = { maxConcurrentRuns: 2, maxTokensPerRun: 200000, maxTokensPerRepository: 1000000 };
let settings = { ...defaultSettings };

async function initialize() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  settings = { ...defaultSettings, ...await loadJson(settingsFile, {}, (v) => v && !Array.isArray(v) && typeof v === "object") };
  for (const project of await loadJson(projectsFile, [], Array.isArray)) projects.set(project.id, project);
  customTemplates = await loadJson(templatesFile, [], Array.isArray);
  {
    const saved = await loadJson(dataFile, [], Array.isArray);
    for (const run of saved) {
      run.logs ||= [];
      run.events ||= [];
      run.retries ||= 0;
      run.executionSeq ||= 0;
      run.usage ||= emptyUsage();
      run.usageSeen ||= [];
      run.cancelRequested = false;
      run.budgetExceeded ||= false;
      run.archived ||= false;
      run.queuedAction ||= run.phase === "implementation" ? "implementation" : "analysis";
      run.starting = false;
      if (run.state === "running") {
        run.state = "failed";
        run.error = "Control plane restarted while this phase was running";
        run.events.push({ type: "run.failed", message: run.error, at: new Date().toISOString() });
      }
      runs.set(run.id, run);
    }
  }
}

function emitRun(run) {
  const payload = `event: run\ndata: ${JSON.stringify(run)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

async function persist(run) {
  await saveJson(dataFile, [...runs.values()]);
  if (run) emitRun(run);
  else for (const client of eventClients) client.write(`event: snapshot\ndata: ${JSON.stringify([...runs.values()])}\n\n`);
}

async function persistSettings() {
  await saveJson(settingsFile, settings);
}

async function persistProjects() {
  await saveJson(projectsFile, [...projects.values()]);
}

async function persistTemplates() {
  await saveJson(templatesFile, customTemplates);
}

const allTemplates = () => [...builtInTemplates, ...customTemplates];

function repositoryTokens(repository) {
  return [...runs.values()].filter((run) => run.repository === repository).reduce((sum, run) => sum + (run.usage?.totalTokens || 0), 0);
}

async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function inspectRepository(input) {
  if (!input || !path.isAbsolute(input)) throw new Error("Repository must be an absolute path");
  const resolved = await realpath(input);
  await access(path.join(resolved, ".git"));
  const branch = (await git(resolved, ["branch", "--show-current"])).trim() || "detached";
  let remote = null;
  try { remote = (await git(resolved, ["remote", "get-url", "origin"])).trim() || null; } catch {}
  return { resolved, branch, remote };
}

async function validateRepository(input) {
  const { resolved } = await inspectRepository(input);
  const status = await git(resolved, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Repository must be clean before starting an isolated run");
  return resolved;
}

function command(commandName, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd, env: process.env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${commandName} exited with code ${code}`)));
    if (input) child.stdin.end(input);
  });
}

const git = (cwd, args, input) => command("git", args, cwd, input);

async function createWorktree(run) {
  run.baseHead = (await git(run.repository, ["rev-parse", "HEAD"])).trim();
  run.baseRef = (await git(run.repository, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  run.branch = `codex-control-plane/${run.id}`;
  run.worktree = path.join(worktreeRoot, run.id);
  await git(run.repository, ["worktree", "add", "-b", run.branch, run.worktree, run.baseHead]);
  run.events.push({ type: "worktree.created", message: `Isolated worktree created on ${run.branch}`, at: new Date().toISOString() });
}

async function cleanupWorktree(run) {
  if (!run.worktree) return;
  try { await git(run.repository, ["worktree", "remove", "--force", run.worktree]); }
  catch { await rm(run.worktree, { recursive: true, force: true }); }
  try { await git(run.repository, ["branch", "-D", run.branch]); } catch {}
  run.worktree = null;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.stopTimer) return;
  child.kill("SIGTERM");
  child.stopTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  child.once("close", () => clearTimeout(child.stopTimer));
}

function executeCodex(run, sandbox, prompt) {
  return new Promise((resolve, reject) => {
    const executionSeq = ++run.executionSeq;
    const startedAt = Date.now();
    const child = spawn("codex", ["exec", "--sandbox", sandbox, "--json", prompt], {
      cwd: run.worktree,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.set(run.id, child);
    let stdout = "";
    let buffer = "";
    let stderr = "";
    const recordLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { event = { type: "output", message: line }; }
      const usageChanged = recordUsage(run, event, executionSeq);
      if (usageChanged && !run.budgetExceeded) {
        let message = null;
        if (settings.maxTokensPerRun > 0 && run.usage.totalTokens > settings.maxTokensPerRun) {
          message = `Run token budget exceeded (${run.usage.totalTokens.toLocaleString()} / ${settings.maxTokensPerRun.toLocaleString()})`;
        } else {
          const repoTokens = repositoryTokens(run.repository);
          if (settings.maxTokensPerRepository > 0 && repoTokens > settings.maxTokensPerRepository) {
            message = `Repository token quota exceeded (${repoTokens.toLocaleString()} / ${settings.maxTokensPerRepository.toLocaleString()})`;
          }
        }
        if (message && ["queued", "running", "approved"].includes(run.state)) {
          exceedBudget(run, message);
          stopChild(child);
        }
      }
      const message = event.message || event.text || event.item?.text || event.item?.content || event.type || "Codex event";
      const display = typeof message === "string" ? message : JSON.stringify(message);
      run.logs.push({ type: event.type || "output", message: display, at: new Date().toISOString() });
      if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500);
      run.updatedAt = new Date().toISOString();
      emitRun(run);
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(recordLine);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      processes.delete(run.id);
      reject(error);
    });
    child.on("close", (code) => {
      processes.delete(run.id);
      addDuration(run, Date.now() - startedAt);
      recordLine(buffer);
      if (run.cancelRequested) reject(new Error("Run cancelled"));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
    });
  });
}

async function analyze(run) {
  try {
    run.queuedAction = null;
    await createWorktree(run);
    transition(run, "running", "Read-only analysis started");
    await persist(run);
    if (run.cancelRequested || stopping) throw new Error("Run cancelled");
    run.output = await executeCodex(
      run,
      "read-only",
      `${run.prompt}\n\nAnalyze the repository and propose a concrete implementation plan. Do not modify files. End with a concise list of files you expect to change.`,
    );
    requestWriteApproval(run);
  } catch (error) {
    if (!["cancelled", "budget_exceeded"].includes(run.state)) transition(run, "failed", "Analysis failed", { error: error.message });
    else await cleanupWorktree(run);
  }
  await persist(run);
}

async function implement(run) {
  try {
    run.queuedAction = null;
    transition(run, "running", "Approved implementation started");
    await persist(run);
    if (run.cancelRequested || stopping) throw new Error("Run cancelled");
    run.output += `\n\n--- Implementation ---\n${await executeCodex(
      run,
      "workspace-write",
      `${run.prompt}\n\nImplement the requested change. Work only inside this repository. Run relevant tests and summarize the changes.`,
    )}`;
    await git(run.worktree, ["add", "-N", "."]);
    const diffStat = await git(run.worktree, ["diff", "--stat"]);
    const diff = await git(run.worktree, ["diff", "--no-ext-diff", "--no-color", "--binary"]);
    if (!diff.trim()) {
      await cleanupWorktree(run);
      transition(run, "completed", "Implementation completed with no file changes");
    } else {
      requestMergeApproval(run, { diff, diffStat });
    }
  } catch (error) {
    if (!["cancelled", "budget_exceeded"].includes(run.state)) transition(run, "failed", "Implementation failed", { error: error.message });
    else if (run.worktree) {
      await git(run.worktree, ["reset", "--hard", "HEAD"]);
      await git(run.worktree, ["clean", "-fd"]);
    }
  }
  await persist(run);
}

async function applyChanges(run) {
  if (run.state !== "awaiting_merge") throw new Error("Run is not awaiting change approval");
  if (!run.baseHead) throw new Error("This older run has no repository baseline; discard it and create a new run");
  const head = (await git(run.repository, ["rev-parse", "HEAD"])).trim();
  const ref = (await git(run.repository, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  if (head !== run.baseHead || ref !== run.baseRef) throw new Error("Original repository HEAD or branch changed; create a new run");
  const status = await git(run.repository, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Original repository changed during the run; clean it before applying");
  await git(run.repository, ["apply", "--check", "--index", "-"], run.diff);
  await git(run.repository, ["apply", "--index", "--whitespace=nowarn", "-"], run.diff);
  applyRun(run);
  await persist(run);
  try { await cleanupWorktree(run); }
  catch (error) { run.error = `Changes applied; worktree cleanup failed: ${error.message}`; }
  await persist(run);
}

function drainQueue() {
  if (!ready || stopping) return;
  while ([...runs.values()].filter((run) => run.starting).length < settings.maxConcurrentRuns) {
    const run = [...runs.values()].find((candidate) => !candidate.starting && (
      (candidate.state === "queued" && candidate.queuedAction === "analysis") ||
      (candidate.state === "approved" && candidate.queuedAction === "implementation")
    ));
    if (!run) break;
    run.starting = true;
    const job = run.queuedAction === "implementation" ? implement : analyze;
    const pending = job(run).catch((error) => console.error(error)).finally(async () => {
      run.starting = false;
      await persist(run).catch((error) => console.error(error));
      jobs.delete(pending);
      drainQueue();
    });
    jobs.add(pending);
  }
}

async function retry(run) {
  if (run.starting || processes.has(run.id)) throw new Error("Run is still stopping; wait before retrying");
  const draft = structuredClone(run);
  prepareRetry(draft);
  if (draft.phase === "analysis") {
    await cleanupWorktree(run);
  } else {
    if (!run.worktree) await createWorktree(run);
    await git(run.worktree, ["reset", "--hard", "HEAD"]);
    await git(run.worktree, ["clean", "-fd"]);
  }
  prepareRetry(run);
  run.state = run.phase === "analysis" ? "queued" : "approved";
  run.queuedAction = run.phase === "analysis" ? "analysis" : "implementation";
  await persist(run);
  drainQueue();
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ready, activeRuns: processes.size });
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1500\n\n");
    eventClients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify([...runs.values()])}\n\n`);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => { clearInterval(heartbeat); eventClients.delete(res); });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/runs") {
    return send(res, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    const run = runs.get(runMatch[1]);
    return run ? send(res, 200, run) : send(res, 404, { error: "Run not found" });
  }
  if (req.method === "DELETE" && runMatch) {
    const run = runs.get(runMatch[1]);
    if (!run) return send(res, 404, { error: "Run not found" });
    if (!terminalStates.has(run.state)) throw new Error("Only completed, failed, cancelled, discarded or budget-limited runs can be deleted");
    if (run.starting || processes.has(run.id)) throw new Error("Run is still stopping; wait before deleting");
    await cleanupWorktree(run);
    runs.delete(run.id);
    await persist();
    return send(res, 200, { deleted: true });
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    return send(res, 200, aggregateUsage([...runs.values()]));
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return send(res, 200, settings);
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const body = await jsonBody(req);
    const next = {
      maxConcurrentRuns: Number(body.maxConcurrentRuns),
      maxTokensPerRun: Number(body.maxTokensPerRun),
      maxTokensPerRepository: Number(body.maxTokensPerRepository),
    };
    if (!Number.isInteger(next.maxConcurrentRuns) || next.maxConcurrentRuns < 1 || next.maxConcurrentRuns > 8) throw new Error("Concurrent runs must be between 1 and 8");
    if (![next.maxTokensPerRun, next.maxTokensPerRepository].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("Token limits must be non-negative integers");
    settings = next;
    await persistSettings();
    drainQueue();
    return send(res, 200, settings);
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    return send(res, 200, [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await jsonBody(req);
    if (!body.name?.trim()) throw new Error("Project name is required");
    const info = await inspectRepository(body.repository);
    if ([...projects.values()].some((project) => project.repository === info.resolved)) throw new Error("This repository is already registered");
    const project = createProject({ name: body.name, repository: info.resolved, branch: info.branch, remote: info.remote });
    projects.set(project.id, project);
    await persistProjects();
    return send(res, 201, project);
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (req.method === "DELETE" && projectMatch) {
    if (!projects.delete(projectMatch[1])) return send(res, 404, { error: "Project not found" });
    await persistProjects();
    return send(res, 200, { deleted: true });
  }
  if (req.method === "GET" && url.pathname === "/api/templates") {
    return send(res, 200, allTemplates());
  }
  if (req.method === "POST" && url.pathname === "/api/templates") {
    const body = await jsonBody(req);
    if (!body.name?.trim() || !body.prompt?.trim()) throw new Error("Template name and prompt are required");
    const template = createTemplate(body);
    customTemplates.push(template);
    await persistTemplates();
    return send(res, 201, template);
  }
  const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
  if (req.method === "DELETE" && templateMatch) {
    const index = customTemplates.findIndex((template) => template.id === templateMatch[1]);
    if (index < 0) return send(res, 404, { error: "Custom template not found" });
    customTemplates.splice(index, 1);
    await persistTemplates();
    return send(res, 200, { deleted: true });
  }
  if (req.method === "POST" && url.pathname === "/api/runs") {
    const body = await jsonBody(req);
    const project = body.projectId ? projects.get(body.projectId) : null;
    if (body.projectId && !project) throw new Error("Project not found");
    const repository = await validateRepository(project?.repository || body.repository);
    if (!body.prompt?.trim()) throw new Error("Task description is required");
    const template = body.templateId ? allTemplates().find((item) => item.id === body.templateId) : null;
    if (body.templateId && !template) throw new Error("Template not found");
    const prompt = renderTemplate(template, body.prompt);
    const used = repositoryTokens(repository);
    if (settings.maxTokensPerRepository > 0 && used >= settings.maxTokensPerRepository) {
      throw new Error(`Repository token quota reached (${used.toLocaleString()} / ${settings.maxTokensPerRepository.toLocaleString()})`);
    }
    const run = createRun({ id: randomUUID(), repository, prompt, projectId: project?.id, templateId: template?.id });
    runs.set(run.id, run);
    if (project) {
      project.lastUsedAt = new Date().toISOString();
      await persistProjects();
    }
    await persist(run);
    drainQueue();
    return send(res, 202, run);
  }
  const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/(approve|reject|apply|discard|cancel|retry|archive|unarchive)$/);
  if (req.method === "POST" && match) {
    const run = runs.get(match[1]);
    if (!run) return send(res, 404, { error: "Run not found" });
    if (run.starting && match[2] !== "cancel") throw new Error("Run is still active or stopping; try again shortly");
    if (match[2] === "archive" || match[2] === "unarchive") {
      if (!terminalStates.has(run.state)) throw new Error("Only finished runs can be archived");
      run.archived = match[2] === "archive";
      run.updatedAt = new Date().toISOString();
      run.events.push({ type: `run.${match[2]}`, message: run.archived ? "Run archived" : "Run restored", at: run.updatedAt });
    } else if (match[2] === "cancel") {
      cancelRun(run);
      const child = processes.get(run.id);
      stopChild(child);
    } else if (match[2] === "retry") {
      await retry(run);
    } else if (match[2] === "reject") {
      rejectRun(run);
      await cleanupWorktree(run);
    } else if (match[2] === "discard") {
      discardRun(run);
      await cleanupWorktree(run);
    } else if (match[2] === "apply") {
      await applyChanges(run);
    } else {
      approveRun(run);
      run.queuedAction = "implementation";
      drainQueue();
    }
    await persist(run);
    return send(res, 202, run);
  }
  return false;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export const controlServer = createServer(async (req, res) => {
  try {
    const localOrigins = [`http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`];
    const origin = `http://${req.headers.host}`;
    if (!localOrigins.includes(origin) || (req.headers.origin && req.headers.origin !== origin)) {
      return send(res, 403, { error: "Only same-origin local requests are allowed" });
    }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith("/api/")) {
      if (!ready || stopping) return send(res, 503, { error: "Runner is starting or stopping" });
      const id = url.pathname.match(/^\/api\/runs\/([^/]+)/)?.[1];
      const run = runs.get(id);
      const mutating = !["GET", "HEAD"].includes(req.method);
      const key = mutating ? (run ? `repo:${run.repository}` : url.pathname) : null;
      if (key && actionLocks.has(key)) return send(res, 409, { error: "Another operation is in progress; try again shortly" });
      if (key) actionLocks.add(key);
      let handled;
      try { handled = await api(req, res, url); }
      finally { if (key) actionLocks.delete(key); }
      if (handled !== false) return;
      return send(res, 404, { error: "Not found" });
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(`${publicDir}${path.sep}`)) return send(res, 403, "Forbidden", "text/plain");
    send(res, 200, await readFile(file, "utf8"), mime[path.extname(file)] || "text/plain; charset=utf-8");
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});

export const serverReady = (async () => {
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(port, "127.0.0.1", () => {
      controlServer.off("error", reject);
      resolve();
    });
  });
  try {
    await initialize();
    await persist();
    ready = true;
    drainQueue();
    const actualPort = controlServer.address().port;
    const url = `http://127.0.0.1:${actualPort}`;
    console.log(`Codex Control Plane: ${url}`);
    return { port: actualPort, url };
  } catch (error) { controlServer.close(); throw error; }
})();

let shutdownPromise;
export function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    controlServer.close();
    for (const client of eventClients) client.end();
    controlServer.closeIdleConnections();
    for (const run of runs.values()) {
      if (run.starting && ["queued", "running", "approved"].includes(run.state)) cancelRun(run);
    }
    for (const child of processes.values()) stopChild(child);
    await Promise.allSettled([...jobs]);
    if (ready) await persist();
  })();
  return shutdownPromise;
}

if (!process.versions.electron) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void shutdown().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); });
  }
}
try { await serverReady; }
catch (error) {
  console.error(startupErrorMessage(error, port));
  process.exitCode = 1;
}
