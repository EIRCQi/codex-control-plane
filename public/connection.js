// A TCP connection alone does not mean the Runner is responding. Require a
// snapshot and watch the server heartbeat, including after laptop sleep.
export function createLiveConnection({ onStatus, onSnapshot, onRun, onAuth, onCatalog, onSettings, onReady,
  Source = EventSource, now = Date.now, schedule = setInterval, unschedule = clearInterval, timeoutMs = 45000 }) {
  let source, lastSeen = 0, connected = false, timer, stopped = true;
  function status(value) {
    if (connected === value) return;
    connected = value; onStatus(value);
  }
  function reconnect() {
    stopped = false; source?.close(); status(false); lastSeen = now();
    const active = new Source('/api/events'); source = active;
    const listen = (type, accept) => active.addEventListener(type, event => {
      if (stopped || source !== active) return;
      try {
        const data = JSON.parse(event.data);
        lastSeen = now();
        accept?.(data);
      } catch { status(false); }
    });
    listen('snapshot', data => {
      onSnapshot(data); status(true); onReady?.();
    });
    listen('run', onRun); listen('auth', onAuth);
    listen('catalog', onCatalog); listen('settings', onSettings);
    listen('heartbeat');
    active.onerror = () => { if (!stopped && source === active) status(false); };
    if (timer === undefined) timer = schedule(() => { if (!stopped && now() - lastSeen >= timeoutMs) reconnect(); }, 5000);
  }
  function close() { stopped = true; source?.close(); unschedule(timer); timer = undefined; status(false); }
  reconnect();
  return { reconnect, close };
}
