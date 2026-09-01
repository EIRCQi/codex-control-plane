import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveRun, createRun, rejectRun, requestWriteApproval, transition } from "./lib/workflow.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, ".codex-control-plane");
const dataFile = path.join(dataDir, "runs.json");
const port = Number(process.env.PORT || 4310);
const runs = new Map();

await mkdir(dataDir, { recursive: true });
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
  return resolved;
}

function executeCodex(run, sandbox, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--sandbox", sandbox, "--json", prompt], {
      cwd: run.repository,
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
    transition(run, "completed", "Implementation completed");
  } catch (error) {
    transition(run, "failed", "Implementation failed", { error: error.message });
  }
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
  const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && match) {
    const run = runs.get(match[1]);
    if (!run) return send(res, 404, { error: "Run not found" });
    if (match[2] === "reject") rejectRun(run);
    else {
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
