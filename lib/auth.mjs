import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { probe } from './runtime.mjs';
import {manageProcessTree, ownedProcessOptions} from './process-tree.mjs';

const isSignedOut = result => result.code === 1 && (!result.reason || result.reason === 'EXIT_ERROR');

// Only expose a browser authorization request, never arbitrary CLI output or tokens.
export function safeLoginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || url.pathname !== '/oauth/authorize' || url.hash) return null;
    if (['access_token', 'refresh_token', 'id_token', 'token', 'code', 'api_key'].some(key => url.searchParams.has(key))) return null;
    if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('client_id') || !url.searchParams.get('state') || !url.searchParams.get('code_challenge')) return null;
    const callback = new URL(url.searchParams.get('redirect_uri'));
    if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) || callback.username || callback.password) return null;
    return url.href;
  } catch { return null; }
}

export function createAuthManager({getExecutable, env, onChange = () => {}, spawnProcess = spawn, probeLogin = probe, manageChild = manageProcessTree, timeoutMs = 180000, killAfterMs = 3000}) {
  const instanceId = randomUUID();
  let value = {instanceId, revision:0, state:'unknown', message:'Check your Codex login to get started.', loginUrl:null, checkedAt:null};
  let session = null, inspection = null, inspectionController = null, disposed = false;
  const snapshot = () => ({...value, busy:Boolean(session)});
  function publish(state, message, extra = {}) {
    value = {...value, revision:value.revision + 1, state, message, loginUrl:null, ...extra};
    onChange(snapshot());
  }
  function finish(task, state, message) {
    if (session !== task) return;
    clearTimeout(task.timer);
    session = null;
    publish(state, message, {checkedAt:new Date().toISOString()});
    task.resolve();
  }
  function stop(task, reason) {
    if (!task || session !== task || task.reason) return;
    task.reason = reason;
    publish('cancelling', reason === 'timed_out' ? 'Login timed out. Stopping the login process…' : 'Stopping the login process…');
    task.controller.abort();
    inspectionController?.abort();
    if (task.scope) void task.scope.stop();
  }
  const cancelled = (task) => {
    if (!task.reason) return false;
    finish(task, task.reason, task.reason === 'timed_out' ? 'Login timed out. Try again when you are ready.' : 'Login cancelled. Any credentials already saved by Codex are kept.');
    return true;
  };
  async function refresh() {
    if (session || disposed) return snapshot();
    if (inspection) return inspection;
    const controller = new AbortController();
    inspectionController = controller;
    publish('checking', 'Checking local Codex credentials…');
    inspection = Promise.resolve().then(async () => {
      try {
        const executable = await getExecutable();
        if (controller.signal.aborted) return snapshot();
        const result = await probeLogin(executable, ['login', 'status'], {env, signal:controller.signal, killAfterMs});
        if (!session && !disposed && !controller.signal.aborted) publish(result.ok ? 'signed_in' : isSignedOut(result) ? 'signed_out' : 'error', result.ok ? 'Local Codex credentials are available. Service access is checked when a task runs.' : 'Login could not be confirmed. Sign in, or check codex login status in your terminal.', {checkedAt:new Date().toISOString()});
      } catch {
        if (!session && !disposed) publish('missing', 'Codex CLI is unavailable. Install it or configure its path in Environment.');
      }
      return snapshot();
    }).finally(() => {inspection = null; inspectionController = null;});
    return inspection;
  }
  function start() {
    if (disposed) throw new Error('Runner is stopping');
    if (session) return snapshot();
    const task = {scope:null, controller:new AbortController(), reason:null};
    task.done = new Promise(resolve => { task.resolve = resolve; });
    session = task;
    publish('starting', 'Preparing Codex browser login…');
    task.timer = setTimeout(() => stop(task, 'timed_out'), timeoutMs);
    void (async () => {
      if (inspection) await inspection;
      if (cancelled(task)) return;
      let executable;
      try { executable = await getExecutable(); }
      catch { if (!cancelled(task)) finish(task, 'missing', 'Codex CLI is unavailable. Install it or configure its path in Environment.'); return; }
      if (cancelled(task)) return;
      const existing = await probeLogin(executable, ['login', 'status'], {env, signal:task.controller.signal, killAfterMs});
      if (cancelled(task)) return;
      if (existing.ok) { finish(task, 'signed_in', 'Your existing Codex login is ready to use.'); return; }
      if (!isSignedOut(existing)) {
        finish(task, 'error', 'Unable to check Codex login. Check Environment or run codex login status in your terminal.'); return;
      }
      const child = spawnProcess(executable, ['login'], {env, ...ownedProcessOptions, stdio:['ignore', 'pipe', 'pipe']});
      task.scope = manageChild(child, {env, graceMs:killAfterMs});
      let failed = false;
      const readLines = (stream) => {
        let buffer = '';
        const consume = (line) => {
          if (task.reason || session !== task) return;
          for (const match of line.matchAll(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s<>"']+/g)) {
            const url = safeLoginUrl(match[0]);
            if (url) publish('waiting', 'Complete sign-in in your browser. If no window opened, use Open sign-in page.', {loginUrl:url});
          }
        };
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end).replace(/\u001b\[[0-9;]*m/g, '')); buffer = buffer.slice(end + 1); }
          if (buffer.length > 16384) buffer = '';
        });
        stream.on('end', () => { consume(buffer); buffer = ''; });
      };
      readLines(child.stdout); readLines(child.stderr);
      child.once('error', () => { failed = true; });
      publish('waiting', 'Complete sign-in in the browser opened by Codex.');
      const {code} = await task.scope.wait();
      if (cancelled(task)) return;
      if (failed || code !== 0) { finish(task, 'error', 'Codex login did not finish. Retry, or run codex login in your terminal for details.'); return; }
      publish('verifying', 'Confirming the saved login…');
      const result = await probeLogin(executable, ['login', 'status'], {env, signal:task.controller.signal, killAfterMs});
      if (cancelled(task)) return;
      finish(task, result.ok ? 'signed_in' : 'error', result.ok ? 'Signed in. You can now create a task.' : 'Login finished but could not be confirmed. Check codex login status in your terminal.');
    })().catch(() => { if (!cancelled(task)) finish(task, 'error', 'Unable to complete Codex login. Check Environment and try again.'); });
    return snapshot();
  }
  return {
    snapshot, refresh, start,
    isLoggingIn: () => Boolean(session),
    async cancel() { const task = session; stop(task, 'cancelled'); if (task) await task.done; return snapshot(); },
    async shutdown() { disposed = true; inspectionController?.abort(); const task = session; stop(task, 'cancelled'); if (task) await task.done; if (inspection) await inspection; },
  };
}
