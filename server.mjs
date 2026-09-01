import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRun, approveRun, createRun, discardRun, rejectRun, requestMergeApproval, requestWriteApproval, transition } from "./lib/workflow.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, ".codex-control-plane");
const dataFile = path.join(dataDir, "runs.json");
const port = Number(process.env.PORT || 4310);
const worktreeRoot = path.join(os.tmpdir(), "codex-control-plane-worktrees");
const runs = new Map();

await mkdir(dataDir, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
try {
  const saved = JSON.parse(await readFile(dataFile, "utf8"));
  for (const run of saved) runs.set(run.id, run);
} catch {}

async function persist() {
  await writeFile(dataFile, JSON.stringify([...runs.values()], null, 2));
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

async function validateRepository(input) {
  if (!input || !path.isAbsolute(input)) throw new Error("Repository must be an absolute path");
  const resolved = await realpath(input);
  await access(path.join(resolved, ".git"));
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
    const child = spawn("codex", ["exec", "--sandbox", sandbox, "--json", prompt], {
      cwd: run.worktree,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
    });
  });
}

async function analyze(run) {
  try {
    await createWorktree(run);
    transition(run, "running", "Read-only analysis started");
    await persist();
    run.output = await executeCodex(
      run,
      "read-only",
      `${run.prompt}\n\nAnalyze the repository and propose a concrete implementation plan. Do not modify files. End with a concise list of files you expect to change.`,
    );
    requestWriteApproval(run);
  } catch (error) {
    transition(run, "failed", "Analysis failed", { error: error.message });
  }
  await persist();
}

async function implement(run) {
  try {
    transition(run, "running", "Approved implementation started");
    await persist();
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
    transition(run, "failed", "Implementation failed", { error: error.message });
  }
  await persist();
}

async function applyChanges(run) {
  const status = await git(run.repository, ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Original repository changed during the run; clean it before applying");
  await git(run.repository, ["apply", "--3way", "--whitespace=nowarn", "-"], run.diff);
  await cleanupWorktree(run);
  applyRun(run);
  await persist();
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/runs") {
    return send(res, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (req.method === "POST" && url.pathname === "/api/runs") {
    const body = await jsonBody(req);
    const repository = await validateRepository(body.repository);
    if (!body.prompt?.trim()) throw new Error("Task description is required");
    const run = createRun({ id: randomUUID(), repository, prompt: body.prompt.trim() });
    runs.set(run.id, run);
    await persist();
    void analyze(run);
    return send(res, 202, run);
  }
  const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/(approve|reject|apply|discard)$/);
  if (req.method === "POST" && match) {
    const run = runs.get(match[1]);
    if (!run) return send(res, 404, { error: "Run not found" });
    if (match[2] === "reject") {
      rejectRun(run);
      await cleanupWorktree(run);
    } else if (match[2] === "discard") {
      discardRun(run);
      await cleanupWorktree(run);
    } else if (match[2] === "apply") {
      await applyChanges(run);
    } else {
      approveRun(run);
      void implement(run);
    }
    await persist();
    return send(res, 202, run);
  }
  return false;
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

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
