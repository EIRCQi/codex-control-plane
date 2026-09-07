import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const runtimeDefaults = { gitPath: '', codexPath: '' };
export function validateRuntimeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime settings must be an object");
  const result = {};
  for (const key of Object.keys(runtimeDefaults)) {
    const entry = value?.[key] ?? '';
    if (typeof entry !== 'string' || entry.includes('\0') || (entry.trim() && !path.isAbsolute(entry.trim()))) {
      throw new Error(`${key} must be an absolute executable path, or empty for automatic detection`);
    }
    result[key] = entry.trim();
  }
  return result;
}

export function runtimeEnvironment(env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH';
  const fallback = process.platform === 'win32' ? [] : [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const directories = [...new Set([...(env[key] || '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)), ...fallback])];
  return { ...env, [key]: directories.join(path.delimiter) };
}

export async function resolveTool(name, settings = runtimeDefaults, env = runtimeEnvironment()) {
  const configured = env[`CODEX_CONTROL_PLANE_${name.toUpperCase()}_BIN`] || settings[`${name}Path`];
  if (configured && !path.isAbsolute(configured)) throw new Error(`${name} override must be an absolute executable path`);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const filenames = process.platform === 'win32' ? [`${name}.exe`] : [name];
  const candidates = configured ? [configured] : (env[pathKey] || '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).flatMap((dir) => filenames.map((file) => path.join(dir, file)));
  for (const candidate of candidates) {
    try {
      if (!((await stat(candidate)).isFile())) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (/\.(cmd|bat)$/i.test(candidate)) throw new Error('Use the native .exe executable, not a .cmd or .bat wrapper');
      return candidate;
    } catch (error) { if (configured) throw new Error(`Cannot execute ${name} at ${candidate}: ${error.message}`); }
  }
  throw new Error(`${name} executable not found. Install it or set its absolute path in Environment settings.${process.platform === 'win32' ? ' Select the native .exe executable on Windows.' : ''}`);
}

// Probe only version and credential-status commands. Never return raw auth output.
export function probe(command, args, { env = runtimeEnvironment(), timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, failure;
    const append = (chunk) => { if (output.length < 8192) output += chunk.toString().slice(0, 8192 - output.length); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', (error) => { failure = error.code || 'SPAWN_ERROR'; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !failure && !timedOut, code, output, reason: timedOut ? 'TIMEOUT' : failure || (code !== 0 ? 'EXIT_ERROR' : null) });
    });
  });
}

export async function diagnose({ settings = runtimeDefaults, env = runtimeEnvironment(), dataDir, version = '', timeoutMs = 4000 } = {}) {
  const checkTool = async (name) => {
    let command;
    try { command = await resolveTool(name, settings, env); }
    catch (error) { return { status: 'missing', command: null, version: null, hint: error.message }; }
    const result = await probe(command, ['--version'], { env, timeoutMs });
    const version = result.ok ? result.output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?\b/)?.[0] : null;
    return { status: result.ok && version ? 'ok' : 'error', command, version: version || null, hint: result.ok && version ? '' : `${name} version check failed${result.reason === 'TIMEOUT' ? ' (timed out)' : ''}. Check this executable in a terminal.` };
  };
  const [git, codex] = await Promise.all([checkTool('git'), checkTool('codex')]);
  let authentication = { status: 'unknown', hint: 'Install or configure Codex before checking login.' };
  if (codex.status === 'ok') {
    const result = await probe(codex.command, ['login', 'status'], { env, timeoutMs });
    authentication = { status: result.ok ? 'ok' : 'unknown', hint: result.ok ? 'Local credentials present; service access and quota are checked when a task runs.' : 'Login could not be confirmed. Run codex login status, then codex login in your terminal if needed.' };
  }
  let storage = { status: 'ok', path: dataDir, hint: '' };
  if (dataDir) {
    let target = dataDir;
    try {
      while (true) {
        try { if (!(await stat(target)).isDirectory()) throw new Error('Not a directory'); break; }
        catch (error) { if (error.code !== 'ENOENT' || path.dirname(target) === target) throw error; target = path.dirname(target); }
      }
      await access(target, constants.W_OK);
      storage.hint = target === dataDir ? 'Data directory is writable.' : 'Data directory will be created at startup.';
    } catch { storage = { ...storage, status: 'error', hint: 'Data directory is not writable. Check folder permissions.' }; }
  }
  return { version, checkedAt: new Date().toISOString(), node: process.versions.node, platform: process.platform, arch: process.arch,
    ready: [git, codex, authentication, storage].every((check) => check.status === 'ok'), git, codex, authentication, storage };
}
