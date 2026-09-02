import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRun, approveRun, cancelRun, createRun, discardRun, exceedBudget, prepareRetry, rejectRun, requestMergeApproval, requestWriteApproval, terminalStates, transition } from "./lib/workflow.mjs";
import { addDuration, aggregateUsage, emptyUsage, recordUsage } from "./lib/usage.mjs";
import { builtInTemplates, createProject, createTemplate, renderTemplate } from "./lib/catalog.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, ".codex-control-plane");
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
let customTemplates = [];
const defaultSettings = { maxConcurrentRuns: 2, maxTokensPerRun: 200000, maxTokensPerRepository: 1000000 };
let settings = { ...defaultSettings };

await mkdir(dataDir, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
try { settings = { ...defaultSettings, ...JSON.parse(await readFile(settingsFile, "utf8")) }; } catch {}
try {
  for (const project of JSON.parse(await readFile(projectsFile, "utf8"))) projects.set(project.id, project);
} catch {}
try { customTemplates = JSON.parse(await readFile(templatesFile, "utf8")); } catch {}
try {
  const saved = JSON.parse(await readFile(dataFile, "utf8"));
  for (const run of saved) {
    run.logs ||= [];
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
} catch {}

function emitRun(run) {
  const payload = `event: run\ndata: ${JSON.stringify(run)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

async function persist(run) {
  await writeFile(dataFile, JSON.stringify([...runs.values()], null, 2));
  if (run) emitRun(run);
}

async function persistSettings() {
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
}

async function persistProjects() {
  await writeFile(projectsFile, JSON.stringify([...projects.values()], null, 2));
}

async function persistTemplates() {
  await writeFile(templatesFile, JSON.stringify(customTemplates, null, 2));
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
  run.branch = `codex-control-plane/${run.id.slice(0, 8)}`;
  run.worktree = path.join(worktreeRoot, run.id);
  await git(run.repository, ["worktree", "add", "-b", run.branch, run.worktree, "HEAD"]);
  run.events.push({ type: "worktree.created", message: `Isolated worktree created on ${run.branch}`, at: new Date().toISOString() });
}

async function cleanupWorktree(run) {
  if (!run.worktree) return;
  try { await git(run.repository, ["worktree", "remove", "--force", run.worktree]); }
  catch { await rm(run.worktree, { recursive: true, force: true }); }
  try { await git(run.repository, ["branch", "-D", run.branch]); } catch {}
  run.worktree = null;
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
          child.kill("SIGTERM");
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
      if (code === 0) resolve(stdout.trim());
      else if (run.cancelRequested) reject(new Error("Run cancelled"));
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
  const status = await git(run.repository, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Original repository changed during the run; clean it before applying");
  await git(run.repository, ["apply", "--3way", "--whitespace=nowarn", "-"], run.diff);
  await cleanupWorktree(run);
  applyRun(run);
  await persist(run);
}

function drainQueue() {
  while ([...runs.values()].filter((run) => run.starting).length < settings.maxConcurrentRuns) {
    const run = [...runs.values()].find((candidate) => !candidate.starting && (
      (candidate.state === "queued" && candidate.queuedAction === "analysis") ||
      (candidate.state === "approved" && candidate.queuedAction === "implementation")
    ));
    if (!run) break;
    run.starting = true;
    const job = run.queuedAction === "implementation" ? implement : analyze;
    void job(run).finally(() => {
      run.starting = false;
      void persist(run);
      drainQueue();
    });
  }
}

async function retry(run) {
  prepareRetry(run);
  if (run.phase === "analysis") {
    await cleanupWorktree(run);
    run.queuedAction = "analysis";
  } else {
    if (!run.worktree) await createWorktree(run);
    await git(run.worktree, ["reset", "--hard", "HEAD"]);
    await git(run.worktree, ["clean", "-fd"]);
    run.state = "approved";
    run.queuedAction = "implementation";
  }
  await persist(run);
  drainQueue();
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1500\n\n");
    eventClients.add(res);
    req.on("close", () => eventClients.delete(res));
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
    if (match[2] === "archive" || match[2] === "unarchive") {
      if (!terminalStates.has(run.state)) throw new Error("Only finished runs can be archived");
      run.archived = match[2] === "archive";
      run.updatedAt = new Date().toISOString();
      run.events.push({ type: `run.${match[2]}`, message: run.archived ? "Run archived" : "Run restored", at: run.updatedAt });
    } else if (match[2] === "cancel") {
      cancelRun(run);
      const child = processes.get(run.id);
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000).unref();
      }
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

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

drainQueue();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await api(req, res, url);
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
}).listen(port, "127.0.0.1", () => {
  console.log(`Codex Control Plane: http://127.0.0.1:${port}`);
});
