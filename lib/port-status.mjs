import { inspectRunner, runnerUrl } from './launcher.mjs';
import { probe } from './runtime.mjs';

export async function portStatus({port, platform = process.platform, inspect = inspectRunner, run = probe}) {
  const url = runnerUrl(port);
  const lines = [`Local Runner: ${url}`];
  let healthy = false;
  try {
    const health = await inspect(url);
    healthy = Boolean(health?.ready);
    lines.push(health ? `Health: ${health.ready ? 'ready' : 'starting or stopping'} · v${health.version}` : 'Health: no IPv4 listener accepted the connection.');
  } catch (error) { lines.push(`Health: ${error.message}`); }
  if (platform === 'win32') {
    lines.push(`To inspect the listener in PowerShell: Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess`);
    return {healthy, text:lines.join('\n')};
  }
  const result = await run('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pids = [...new Set(result.output.trim().split(/\s+/).filter(pid => /^[1-9]\d*$/.test(pid)))].slice(0, 16);
  if (pids.length) {
    // Read process names, never command arguments, prompts or environment values.
    const processes = await run('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,stat=,comm=']);
    if (processes.ok) {
      lines.push('Listening processes (PID  PPID  STATE  COMMAND):', processes.output.trim());
      if (processes.output.split('\n').some(line => /^\s*\d+\s+\d+\s+T/.test(line))) {
        lines.push('State T means a suspended process. In its original terminal, use jobs -l to find that PID, then fg %N (replace N with its job number) to resume it. Press Ctrl+C there if you want to stop that Runner. Ctrl+Z suspends a process and leaves its port occupied.');
      }
    } else lines.push(`Listening process IDs: ${pids.join(', ')}. Process details are unavailable.`);
    if (!healthy) lines.push('If this is an existing Control Plane, quit it from its tray or its original terminal (Ctrl+C), then run npm run open again.');
  } else {
    lines.push(result.code === 1 ? 'No listening process was visible to lsof; it may have exited or be inaccessible to this user.' : `Listener details are unavailable. Inspect manually: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }
  return {healthy, text:lines.join('\n')};
}
