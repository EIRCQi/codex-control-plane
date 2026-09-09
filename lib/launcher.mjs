import { Agent, get } from 'node:http';
import { spawn } from 'node:child_process';

export const applicationId = 'codex-control-plane';

export function runnerUrl(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return `http://127.0.0.1:${port}`;
}

export function inspectRunner(url, {timeoutMs = 5000} = {}) {
  const target = new URL(url);
  if (target.origin !== runnerUrl(Number(target.port || 80)) || target.username || target.password) throw new Error('Only a local Runner can be reused');
  return new Promise((resolve, reject) => {
    // Loopback must stay local even when Node's global agent uses an HTTP proxy.
    // This agent does not change the environment inherited by Codex or Git.
    const agent = new Agent({keepAlive:false, proxyEnv:{}});
    let size = 0, body = '', connected = false, settled = false, request;
    function finish(error, health = null) {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(health);
      request?.destroy(); agent.destroy();
    }
    // A wall-clock deadline also bounds connection stalls and partial responses.
    const deadline = setTimeout(() => {
      const message = connected ? `Port ${target.port} accepted a TCP connection but is not responding to /api/health within ${timeoutMs} ms. The process may be busy or suspended.` : `Could not connect to the local Runner on port ${target.port} within ${timeoutMs} ms.`;
      finish(Object.assign(new Error(message), {code:'RUNNER_PROBE_TIMEOUT', connected}));
    }, timeoutMs);
    request = get(new URL('/api/health', target), {agent}, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8192) {
          finish(new Error('The occupied port did not return a valid Runner response'));
        }
        else body += chunk;
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode !== 200 || health.app !== applicationId || typeof health.ready !== 'boolean' || typeof health.version !== 'string') throw new Error();
          finish(null, health);
        } catch { finish(new Error(`Port ${target.port} is occupied by an older Runner or another application. Quit it once before upgrading; no process was stopped.`)); }
      });
      response.on('error', error => finish(error));
    });
    request.on('socket', socket => {
      connected = !socket.connecting;
      socket.once('connect', () => { connected = true; });
    });
    request.on('error', error => finish(error.code === 'ECONNREFUSED' ? null : error));
  });
}

export async function selectRunner({port, start, inspect = inspectRunner}) {
  const existing = port === 0 ? null : await inspect(runnerUrl(port));
  if (existing) {
    if (!existing.ready) throw new Error('The existing Runner is still starting or stopping. Try opening it again shortly.');
    return {url:runnerUrl(port), reused:true, version:existing.version, shutdown:null};
  }
  const owned = await start();
  return {...owned, reused:false};
}

export function openDashboard(url, {platform = process.platform, spawnProcess = spawn} = {}) {
  const target = new URL(url);
  if (target.href !== `${runnerUrl(Number(target.port || 80))}/`) throw new Error('Only the local dashboard can be opened');
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', target.href] : [target.href];
  return new Promise(resolve => {
    const child = spawnProcess(command, args, {stdio:'ignore', windowsHide:true});
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
