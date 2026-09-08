const logKey = (log) => JSON.stringify([log.at, log.type, log.message]);

function countNewLogs(previous, next) {
  const counts = new Map();
  for (const log of previous) counts.set(logKey(log), (counts.get(logKey(log)) || 0) + 1);
  let added = 0;
  for (const log of next) {
    const key = logKey(log), count = counts.get(key) || 0;
    if (count) counts.set(key, count - 1);
    else added++;
  }
  return added;
}

export function createEventBuffer() {
  let runId, latest = [], displayed = [], paused = false, query = '';
  return {
    update(run) {
      const changedTask = runId !== run.id;
      if (changedTask) { runId = run.id; paused = false; query = ''; }
      latest = (run.logs || []).slice(-500).map((log) => ({
        at: String(log.at || ''), type: String(log.type || ''), message: String(log.message || ''),
      }));
      if (!paused) displayed = latest;
      return changedTask;
    },
    setPaused(value) { paused = value; if (!paused) displayed = latest; },
    search(value) { query = value.trim().toLowerCase(); },
    view() {
      return {
        paused, total: displayed.length, pending: paused ? countNewLogs(displayed, latest) : 0,
        logs: displayed.filter((log) => !query || `${log.type} ${log.message}`.toLowerCase().includes(query)),
      };
    },
  };
}

// Keep retained rows in place so an arriving event cannot replace selected text.
export function createEventViewer(root, {isActive}) {
  const buffer = createEventBuffer();
  const search = root.querySelector('[data-event-search]');
  const pause = root.querySelector('[data-event-pause]');
  const latest = root.querySelector('[data-event-latest]');
  const count = root.querySelector('[data-event-count]');
  const status = root.querySelector('[data-event-status]');
  const lines = root.querySelector('[data-event-lines]');
  const empty = root.querySelector('[data-event-empty]');
  const rows = new Map();
  let following = true, top = 0, left = 0;

  function writeText(node, value) { if (node.textContent !== value) node.textContent = value; }
  function statusText(view) {
    return view.paused ? `Display paused · ${view.pending} newer events available. The task continues running.` : following ? 'Following latest events' : 'Reading earlier events · use Jump to latest to follow';
  }
  function restoreScroll() {
    if (!isActive()) return;
    lines.scrollTop = following && !buffer.view().paused ? lines.scrollHeight : top;
    lines.scrollLeft = left;
    top = lines.scrollTop;
  }
  function render() {
    const view = buffer.view();
    const occurrences = new Map();
    const keyed = view.logs.map((log) => {
      const key = logKey(log), n = occurrences.get(key) || 0;
      occurrences.set(key, n + 1);
      return {key: `${n}:${key}`, log};
    });
    const visible = new Set(keyed.map((row) => row.key));
    for (const [key, node] of rows) if (!visible.has(key)) { node.remove(); rows.delete(key); }
    keyed.forEach(({key, log}, index) => {
      let node = rows.get(key);
      if (!node) {
        const doc = root.ownerDocument;
        node = doc.createElement('div');
        const time = doc.createElement('time'), type = doc.createElement('b'), message = doc.createElement('span');
        time.textContent = new Date(log.at).toLocaleTimeString(); time.dateTime = log.at;
        type.textContent = log.type; message.textContent = log.message;
        node.append(time, type, message); rows.set(key, node);
      }
      if (lines.children[index] !== node) lines.insertBefore(node, lines.children[index] || null);
    });
    pause.textContent = view.paused ? 'Resume display' : 'Pause display';
    pause.setAttribute('aria-pressed', String(view.paused));
    latest.textContent = view.paused ? 'Resume & follow' : 'Jump to latest';
    writeText(count, `${view.logs.length} of ${view.total} events · latest 500 kept`);
    writeText(status, statusText(view));
    empty.hidden = view.logs.length > 0;
    writeText(empty, view.total ? 'No matching events. Change or clear your search.' : 'No Codex events yet.');
    restoreScroll();
  }
  search.addEventListener('input', () => {
    buffer.search(search.value); top = 0; following = false; render();
  });
  pause.addEventListener('click', () => { buffer.setPaused(!buffer.view().paused); render(); });
  latest.addEventListener('click', () => { buffer.setPaused(false); following = true; render(); });
  lines.addEventListener('scroll', () => {
    if (!isActive()) return;
    top = lines.scrollTop; left = lines.scrollLeft;
    if (!buffer.view().paused) following = lines.scrollHeight - lines.clientHeight - top < 8;
    writeText(status, statusText(buffer.view()));
  });
  return {
    update(run) {
      if (buffer.update(run)) { search.value = ''; following = true; top = 0; left = 0; }
      render();
    },
    activate: restoreScroll,
    deactivate() { if (isActive()) { top = lines.scrollTop; left = lines.scrollLeft; } },
  };
}
