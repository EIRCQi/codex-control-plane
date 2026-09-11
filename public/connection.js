// A TCP connection alone does not mean the Runner is responding. Require a
// snapshot and watch the server heartbeat, including after laptop sleep.
export function createLiveConnection({ onStatus, onSnapshot, onRun, onAuth, onCatalog, onSettings, onSession, onReady,
  Source = EventSource, now = Date.now, schedule = setInterval, unschedule = clearInterval, timeoutMs = 45000 }) {
  let source, lastSeen = 0, awaitingSince = 0, broken = false, connected = false, timer, stopped = true;
  function status(value) {
    if (connected === value) return;
    connected = value; onStatus(value);
  }
  function reconnect() {
    stopped = false; source?.close(); status(false); lastSeen = awaitingSince = now(); broken = false;
    const active = new Source('/api/events'); source = active;
    const listen = (type, accept) => active.addEventListener(type, event => {
      if (stopped || source !== active) return;
      try {
        const data = JSON.parse(event.data);
        accept?.(data);
        lastSeen = now();
      } catch { broken = true; status(false); }
    });
    listen('snapshot', data => {
      if (!Array.isArray(data)) throw new Error('Invalid run snapshot');
      const recovered = !connected;
      onSnapshot(data); status(true); if (recovered) onReady?.();
    });
    listen('session', onSession);
    listen('run', onRun); listen('auth', onAuth);
    listen('catalog', onCatalog); listen('settings', onSettings);
    listen('heartbeat');
    active.onerror = () => { if (!stopped && source === active) { if (connected) awaitingSince = now(); status(false); } };
    if (timer === undefined) timer = schedule(() => {
      if (!stopped && (broken || now() - lastSeen >= timeoutMs || (!connected && now() - awaitingSince >= timeoutMs))) reconnect();
    }, 5000);
  }
  function close() { stopped = true; source?.close(); unschedule(timer); timer = undefined; status(false); }
  reconnect();
  return { reconnect, close };
}
