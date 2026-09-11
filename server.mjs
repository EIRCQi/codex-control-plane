import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRun, approveRun, cancelRun, createRun, discardRun, exceedBudget, prepareRetry, rejectRun, requestMergeApproval, requestWriteApproval, terminalStates, transition, touchRun } from "./lib/workflow.mjs";
import { aggregateUsage, emptyUsage, recordUsage } from "./lib/usage.mjs";
import { builtInTemplates, createProject, createTemplate, renderTemplate } from "./lib/catalog.mjs";
import { saveJson, loadJson } from "./lib/storage.mjs";
import { diagnose, resolveTool, runtimeEnvironment, runtimeDefaults, validateRuntimeSettings } from "./lib/runtime.mjs";
import { createRunPublisher } from "./lib/live-events.mjs";
import { startupErrorMessage } from "./lib/startup.mjs";
import { createAuthManager } from "./lib/auth.mjs";
import { applicationId } from "./lib/launcher.mjs";
import { defaultSettings, validateSettings, budgetReason } from './lib/budget.mjs';
import { beginExecution, checkpointExecution, appendReport, appendDiagnostic, finishExecution, recoverExecutions, createLineReader, parseCodexLine } from './lib/execution.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = process.env.CODEX_CONTROL_PLANE_DATA_DIR || path.join(root, ".codex-control-plane");
const dataFile = path.join(dataDir, "runs.json");
const settingsFile = path.join(dataDir, "settings.json");
const projectsFile = path.join(dataDir, "projects.json");
const runtimeFile = path.join(dataDir, "runtime.json");
const appVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const runnerEnv = runtimeEnvironment();
const runnerId = randomUUID();
let checkpointTimer;
let runtimeSettings = { ...runtimeDefaults };
let diagnosticsPromise = null;
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
let settings = { ...defaultSettings };
const auth = createAuthManager({
  getExecutable: () => resolveTool('codex', runtimeSettings, runnerEnv),
  env: runnerEnv,
  onChange: (state) => {
    diagnosticsPromise = null;
    if (!stopping) for (const client of eventClients) client.write(`event: auth\ndata: ${JSON.stringify(state)}\n\n`);
  },
});

async function initialize() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  settings = validateSettings({ ...defaultSettings, ...await loadJson(settingsFile, {}, (v) => v && !Array.isArray(v) && typeof v === "object") });
  for (const project of await loadJson(projectsFile, [], Array.isArray)) projects.set(project.id, project);
  customTemplates = await loadJson(templatesFile, [], Array.isArray);
  runtimeSettings = validateRuntimeSettings(await loadJson(runtimeFile, runtimeDefaults));
  {
    const saved = await loadJson(dataFile, [], Array.isArray);
    for (const run of saved) {
      run.mode ||= "implement";
      run.logs ||= [];
      run.events ||= [];
      run.retries ||= 0;
      run.executionSeq ||= 0;
      run.runnerId = runnerId;
      run.usage ||= emptyUsage();
      run.usageSeen ||= [];
      run.cancelRequested = false;
      run.budgetExceeded ||= false;
      run.archived ||= false;
      run.queuedAction ||= run.phase === "implementation" ? "implementation" : "analysis";
      run.starting = false;
      recoverExecutions(run);
      if (run.state === "running") {
        run.state = "failed";
        run.error = "Control plane restarted while this phase was running";
        run.updatedAt = new Date().toISOString();
        run.events.push({ type: "run.failed", message: run.error, at: run.updatedAt });
      }
      touchRun(run, run.updatedAt);
      runs.set(run.id, run);
    }
  }
}

function writeRun(run) {
  const payload = `event: run\ndata: ${JSON.stringify(run)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

const runPublisher = createRunPublisher(writeRun);
const emitRun = (run) => runPublisher.immediate(run);

async function persist(run) {
  if (run) touchRun(run);
  await saveJson(dataFile, [...runs.values()]);
  if (run) emitRun(run);
  else for (const client of eventClients) client.write(`event: snapshot\ndata: ${JSON.stringify([...runs.values()])}\n\n`);
}

function broadcast(type, value) {
  if (stopping) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

async function persistProjects() {
  await saveJson(projectsFile, [...projects.values()]);
  broadcast('catalog', { projects: [...projects.values()], templates: allTemplates() });
}

async function persistTemplates() {
  await saveJson(templatesFile, customTemplates);
  broadcast('catalog', { projects: [...projects.values()], templates: allTemplates() });
}

const allTemplates = () => [...builtInTemplates, ...customTemplates];

function repositoryTokens(repository) {
  return [...runs.values()].filter((run) => run.repository === repository).reduce((sum, run) => sum + (run.usage?.totalTokens || 0), 0);
}

async function jsonBody(req) {
  let raw = "";
  req.setEncoding("utf8");
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
  try { await git(resolved, ['rev-parse', '--verify', 'HEAD']); }
  catch { throw new Error('Repository needs an initial Git commit before starting a task'); }
  const status = await git(resolved, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Repository must be clean before starting an isolated run");
  return resolved;
}

function command(commandName, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd, env: runnerEnv, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${commandName} exited with code ${code}`)));
    if (input) { child.stdin.on("error", reject); child.stdin.end(input); }
  });
}

const git = async (cwd, args, input) => command(await resolveTool("git", runtimeSettings, runnerEnv), args, cwd, input);

async function createWorktree(run, { preserveBaseline = false } = {}) {
  if (preserveBaseline) requireBaseline(run);
  else {
    run.baseHead = (await git(run.repository, ["rev-parse", "HEAD"])).trim();
    run.baseRef = (await git(run.repository, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  }
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

function requireBaseline(run) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(run.baseHead || "")) {
    throw new Error("This older run has no valid repository baseline; discard it and create a new run");
  }
}

async function verifyRepositoryBaseline(run) {
  requireBaseline(run);
  const head = (await git(run.repository, ["rev-parse", "HEAD"])).trim();
  const ref = (await git(run.repository, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  if (head !== run.baseHead || ref !== run.baseRef) throw new Error("Original repository HEAD or branch changed; create a new run");
  const status = await git(run.repository, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Original repository changed during the run; clean it before continuing");
}

async function resetWorktree(run) {
  requireBaseline(run);
  await git(run.worktree, ["reset", "--hard", run.baseHead]);
  await git(run.worktree, ["clean", "-fd"]);
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.stopTimer) return;
  child.kill("SIGTERM");
  child.stopTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  child.once("close", () => clearTimeout(child.stopTimer));
}

async function executeCodex(run, sandbox, prompt) {
  const executable = await resolveTool("codex", runtimeSettings, runnerEnv);
  if (run.cancelRequested || stopping) throw new Error("Run cancelled");
  if (enforceBudget(run)) throw new Error('Run cancelled');
  if (run.mode === "review" && sandbox !== "read-only") throw new Error("Read-only reviews cannot request write access");
  const entry = beginExecution(run);
  run.lastEventAt = null;
  try { await persist(run); }
  catch (error) { finishExecution(run, entry, 'failed', {error:error.message}); throw error; }
  if (run.cancelRequested || stopping) {
    finishExecution(run, entry, run.budgetExceeded ? 'budget_exceeded' : 'cancelled');
    throw new Error('Run cancelled');
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ["exec", "--sandbox", sandbox, "--json", prompt], {
        cwd: run.worktree, env: runnerEnv, windowsHide:true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finishExecution(run, entry, 'failed', {error:error.message}); reject(error); return;
    }
    processes.set(run.id, child);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let spawnError = null, protocolError = null;
    const log = (type, message) => {
      run.lastEventAt = new Date().toISOString();
      run.logs.push({type, message:String(message).slice(0, 16384), at:run.lastEventAt, executionSeq:entry.seq});
      if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500);
      touchRun(run); runPublisher.schedule(run);
    };
    const output = createLineReader(line => {
      const {event, plain} = parseCodexLine(line);
      if (recordUsage(run, event, entry.seq)) enforceBudget(run);
      if (plain) appendReport(run, entry, line);
      else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') appendReport(run, entry, event.item.text);
      if (event.type === 'turn.failed') protocolError = event.error?.message || 'Codex turn failed';
      if (event.type === 'turn.completed') protocolError = null;
      const message = event.message || event.text || event.item?.text || event.item?.content || event.error?.message || event.type || 'Codex event';
      log(typeof event.type === 'string' ? event.type : 'output', typeof message === 'string' ? message : JSON.stringify(message));
    }, {onOverflow:() => log('output.truncated', 'An oversized Codex event was skipped; later events will still be processed')});
    const diagnostics = createLineReader(line => log('stderr', line), {limit:32768, onOverflow:() => log('output.truncated','An oversized diagnostic line was truncated')});
    child.stdout.on('data', chunk => output.write(chunk));
    child.stderr.on('data', chunk => { appendDiagnostic(entry, chunk); diagnostics.write(chunk); });
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      processes.delete(run.id); output.end(); diagnostics.end();
      const error = spawnError?.message || protocolError || (code === 0 ? null : entry.diagnostics.trim() || `Codex exited with code ${code}`);
      const status = run.budgetExceeded ? 'budget_exceeded' : run.cancelRequested ? 'cancelled' : error ? 'failed' : 'completed';
      finishExecution(run, entry, status, {exitCode:code, error});
      if (run.cancelRequested) reject(new Error('Run cancelled'));
      else if (error) reject(new Error(error));
      else resolve(entry.output);
    });
  });
}

async function analyze(run) {
  try {
    run.queuedAction = null;
    await createWorktree(run);
    transition(run, "running", run.mode === "review" ? "Read-only review started" : "Read-only analysis started");
    await persist(run);
    if (run.cancelRequested || stopping) throw new Error("Run cancelled");
    await executeCodex(
      run,
      "read-only",
      run.mode === "review" ? `${run.prompt}\n\nReview only. Do not modify files. Report concrete findings with severity, file references and suggested next steps.` : `${run.prompt}\n\nAnalyze the repository and propose a concrete implementation plan. Do not modify files. End with a concise list of files you expect to change.`,
    );
    if (run.mode === "review") {
      await cleanupWorktree(run);
      transition(run, "completed", "Read-only review complete");
    } else requestWriteApproval(run);
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
    await executeCodex(
      run,
      "workspace-write",
      `${run.prompt}\n\nImplement the requested change. Work only inside this repository. Run relevant tests and summarize the changes.`,
    );
    requireBaseline(run);
    await git(run.worktree, ["add", "-N", "."]);
    const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
    const diffStat = await git(run.worktree, ["diff", ...diffOptions, "--stat", run.baseHead, "--"]);
    const diff = await git(run.worktree, ["diff", ...diffOptions, "--binary", run.baseHead, "--"]);
    if (!diff.trim()) {
      await cleanupWorktree(run);
      transition(run, "completed", "Implementation completed with no file changes");
    } else {
      requestMergeApproval(run, { diff, diffStat });
    }
  } catch (error) {
    if (!["cancelled", "budget_exceeded"].includes(run.state)) transition(run, "failed", "Implementation failed", { error: error.message });
    else if (run.worktree) {
      await resetWorktree(run);
    }
  }
  await persist(run);
}

async function applyChanges(run) {
  if (run.state !== "awaiting_merge") throw new Error("Run is not awaiting change approval");
  await verifyRepositoryBaseline(run);
  await git(run.repository, ["apply", "--check", "--index", "-"], run.diff);
  await git(run.repository, ["apply", "--index", "--whitespace=nowarn", "-"], run.diff);
  applyRun(run);
  await persist(run);
  try { await cleanupWorktree(run); }
  catch (error) { run.error = `Changes applied; worktree cleanup failed: ${error.message}`; }
  await persist(run);
}

async function checkChanges(run) {
  const result = {runId:run.id, revision:run.revision, checkedAt:new Date().toISOString(), canApply:false};
  try {
    if (run.state !== 'awaiting_merge') throw new Error('Run is not awaiting change approval');
    if (run.starting) throw new Error('Run is still active or stopping; try again shortly');
    await verifyRepositoryBaseline(run);
    await git(run.repository, ['apply', '--check', '--index', '-'], run.diff);
    return {...result, canApply:true};
  } catch (error) { return {...result, error:error.message}; }
}

function drainQueue() {
  if (!ready || stopping) return;
  while ([...runs.values()].filter((run) => run.starting).length < settings.maxConcurrentRuns) {
    const run = [...runs.values()].find((candidate) => !candidate.starting && (
      (candidate.state === "queued" && candidate.queuedAction === "analysis") ||
      (candidate.state === "approved" && candidate.queuedAction === "implementation")
    ));
    if (!run) break;
    if (enforceBudget(run)) {
      void persist(run).catch(error => console.error(error));
      continue;
    }
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

function enforceBudget(run) {
  if (!['queued', 'running', 'approved'].includes(run.state)) return false;
  const reason = budgetReason(run, settings, repositoryTokens(run.repository));
  if (!reason) return false;
  exceedBudget(run, reason);
  stopChild(processes.get(run.id));
  return true;
}

async function retry(run) {
  if (run.starting || processes.has(run.id)) throw new Error("Run is still stopping; wait before retrying");
  const draft = structuredClone(run);
  prepareRetry(draft);
  const reason = budgetReason(run, settings, repositoryTokens(run.repository));
  if (reason) throw new Error(reason);
  if (draft.phase === "analysis") {
    await cleanupWorktree(run);
  } else {
    await verifyRepositoryBaseline(run);
    if (run.worktree) {
      try { await access(path.join(run.worktree, ".git")); }
      catch (error) { if (error.code !== "ENOENT") throw error; await cleanupWorktree(run); }
    }
    if (!run.worktree) await createWorktree(run, { preserveBaseline: true });
    await resetWorktree(run);
  }
  prepareRetry(run);
  run.state = run.phase === "analysis" ? "queued" : "approved";
  run.queuedAction = run.phase === "analysis" ? "analysis" : "implementation";
  await persist(run);
  drainQueue();
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/status') return send(res, 200, auth.snapshot());
  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') return send(res, 200, await auth.refresh());
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (processes.size || [...runs.values()].some(run => run.starting || ['queued', 'running', 'approved'].includes(run.state))) {
      return send(res, 409, {error:'Finish or cancel running and queued tasks before starting login.'});
    }
    return send(res, 202, auth.start());
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/cancel') return send(res, 200, await auth.cancel());
  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    if (!diagnosticsPromise) {
      const pending = diagnose({ settings: runtimeSettings, env: runnerEnv, dataDir, version: appVersion })
        .finally(() => { if (diagnosticsPromise === pending) diagnosticsPromise = null; });
      diagnosticsPromise = pending;
    }
    return send(res, 200, await diagnosticsPromise);
  }
  if (req.method === "GET" && url.pathname === "/api/runtime") {
    return send(res, 200, { ...runtimeSettings, overrides: {
      gitPath: Boolean(runnerEnv.CODEX_CONTROL_PLANE_GIT_BIN), codexPath: Boolean(runnerEnv.CODEX_CONTROL_PLANE_CODEX_BIN),
    } });
  }
  if (req.method === "PUT" && url.pathname === "/api/runtime") {
    if ([...runs.values()].some((run) => !terminalStates.has(run.state) || run.starting)) throw new Error("Finish or cancel pending runs before changing executable paths");
    const next = validateRuntimeSettings(await jsonBody(req));
    for (const key of ["gitPath", "codexPath"]) {
      if (next[key]) await resolveTool(key === "gitPath" ? "git" : "codex", next, { ...runnerEnv, CODEX_CONTROL_PLANE_GIT_BIN: '', CODEX_CONTROL_PLANE_CODEX_BIN: '' });
    }
    await saveJson(runtimeFile, next);
    runtimeSettings = next;
    diagnosticsPromise = null;
    return send(res, 200, next);
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { app:applicationId, ready:ready && !stopping, version: appVersion, activeRuns: processes.size });
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1500\n\n");
    eventClients.add(res);
    res.write(`event: session\ndata: ${JSON.stringify({runnerId})}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify([...runs.values()])}\n\n`);
    res.write(`event: auth\ndata: ${JSON.stringify(auth.snapshot())}\n\n`);
    const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 15000);
    req.on("close", () => { clearInterval(heartbeat); eventClients.delete(res); });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/runs") {
    return send(res, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  const checkMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/change-check$/);
  if (req.method === 'GET' && checkMatch) {
    const run = runs.get(checkMatch[1]);
    return run ? send(res, 200, await checkChanges(run)) : send(res, 404, {error:'Run not found'});
  }
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
    const next = validateSettings(await jsonBody(req));
    await saveJson(settingsFile, next);
    settings = next;
    broadcast('settings', settings);
    const stopped = [...runs.values()].filter(enforceBudget);
    if (stopped.length) await persist();
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
    const mode = template?.mode === "review" ? "review" : (body.mode || "implement");
    if (!["implement", "review"].includes(mode)) throw new Error("Unsupported task mode");
    await resolveTool("codex", runtimeSettings, runnerEnv);
    const prompt = renderTemplate(template, body.prompt);
    const used = repositoryTokens(repository);
    if (settings.maxTokensPerRepository > 0 && used >= settings.maxTokensPerRepository) {
      throw new Error(`Repository token quota reached (${used.toLocaleString()} / ${settings.maxTokensPerRepository.toLocaleString()})`);
    }
    const run = createRun({ id: randomUUID(), repository, prompt, task: body.prompt.trim(), templatePrompt: template?.prompt || null, mode, projectId: project?.id, templateId: template?.id });
    run.runnerId = runnerId;
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
    if (run.mode === "review" && ["approve", "apply"].includes(match[2])) throw new Error("Read-only reviews cannot request write access");
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
      const reason = budgetReason(run, settings, repositoryTokens(run.repository));
      if (reason) throw new Error(reason);
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
      if ((!ready || stopping) && url.pathname !== '/api/health') return send(res, 503, { error: "Runner is starting or stopping" });
      const id = url.pathname.match(/^\/api\/runs\/([^/]+)/)?.[1];
      const run = runs.get(id);
      const mutating = !["GET", "HEAD"].includes(req.method);
      const key = mutating || (run && url.pathname.endsWith('/change-check')) ? (run ? `repo:${run.repository}` : url.pathname) : null;
      const needsCredentials = url.pathname === '/api/runs' || url.pathname === '/api/runtime' || /\/(approve|retry)$/.test(url.pathname);
      if (mutating && needsCredentials && auth.isLoggingIn()) return send(res, 409, {error:'Finish or cancel Codex login before changing runtime settings or starting a task.'});
      if (key && ((key === '/api/auth/login' && actionLocks.size) || (actionLocks.has('/api/auth/login') && !url.pathname.startsWith('/api/auth/')))) return send(res, 409, {error:'Another operation is in progress; try again shortly.'});
      if (key && (actionLocks.has(key) || (actionLocks.has("/api/runtime") && url.pathname !== "/api/runtime") || (url.pathname === "/api/runtime" && actionLocks.size))) return send(res, 409, { error: "Another operation is in progress; try again shortly" });
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
    checkpointTimer = setInterval(() => {
      if (stopping) return;
      const active = [...runs.values()].filter(run => run.executions?.at(-1)?.status === 'running');
      if (!active.length) return;
      for (const run of active) { checkpointExecution(run.executions.at(-1)); touchRun(run); }
      void saveJson(dataFile, [...runs.values()]).then(() => active.forEach(emitRun)).catch(error => console.error(error));
    }, 5000);
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
  clearInterval(checkpointTimer);
  shutdownPromise = (async () => {
    controlServer.close();
    await auth.shutdown();
    for (const client of eventClients) client.end();
    controlServer.closeIdleConnections();
    for (const run of runs.values()) {
      if (run.starting && ["queued", "running", "approved"].includes(run.state)) cancelRun(run);
    }
    for (const child of processes.values()) stopChild(child);
    await Promise.allSettled([...jobs]);
    if (ready) await persist();
    runPublisher.clear();
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
