export function setupEnvironment({ request, escapeHtml, onReport = () => {} }) {
  const panel = document.querySelector('#environment-panel');
  const form = document.querySelector('#runtime-settings');
  const refreshButton = document.querySelector('#refresh-environment');
  const status = document.querySelector('#environment-status');
  const controls = [...panel.querySelectorAll('button, input')];
  let loaded = false;
  let pending = null;

  function render(report) {
    document.querySelector('#app-version').textContent = `v${report.version}`;
    document.querySelector('#environment-summary').textContent = report.ready ? 'Local checks passed' : 'Setup needs attention';
    document.querySelector('#environment-summary').className = `environment-summary ${report.ready ? 'ok' : 'attention'}`;
    document.querySelector('#environment-checks').innerHTML = [
      ['git', 'Git'], ['codex', 'Codex CLI'], ['authentication', 'Codex login'], ['storage', 'Task data'],
    ].map(([key, title]) => {
      const entry = report[key];
      const label = entry.status === 'ok' ? 'OK' : entry.status === 'unknown' ? 'Unconfirmed' : entry.status === 'missing' ? 'Missing' : 'Check failed';
      return `<article><div><h3>${title}</h3><span class="check-status ${entry.status === 'ok' ? 'ok' : 'attention'}">${label}</span></div>${entry.version ? `<strong>${escapeHtml(entry.version)}</strong>` : ''}${entry.command || entry.path ? `<code>${escapeHtml(entry.command || entry.path)}</code>` : ''}<p>${escapeHtml(entry.hint)}</p></article>`;
    }).join('');
    document.querySelector('#environment-meta').textContent = `Node ${report.node} · ${report.platform}/${report.arch} · Checked ${new Date(report.checkedAt).toLocaleTimeString()}`;
    onReport(report);
  }

  function busy(value) {
    controls.forEach((control) => { control.disabled = value; });
    panel.setAttribute('aria-busy', String(value));
  }

  async function refresh() {
    if (pending) return pending;
    busy(true);
    status.textContent = 'Checking local environment…';
    pending = (async () => {
      try {
        if (!loaded) {
          const settings = await request('/api/runtime').then((response) => response.json());
          for (const key of ['gitPath', 'codexPath']) {
            form.elements[key].value = settings[key];
            form.elements[key].readOnly = settings.overrides[key];
            document.querySelector(`#${key}-override`).hidden = !settings.overrides[key];
          }
          loaded = true;
        }
        render(await request('/api/diagnostics').then((response) => response.json()));
        status.textContent = '';
      } catch (error) { status.textContent = error.message; }
      finally { busy(false); pending = null; }
    })();
    return pending;
  }

  refreshButton.addEventListener('click', () => { void refresh(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    const body = { gitPath: form.elements.gitPath.value, codexPath: form.elements.codexPath.value };
    busy(true);
    status.textContent = 'Saving executable paths…';
    try {
      await request('/api/runtime', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      loaded = false;
      await refresh();
    } catch (error) { status.textContent = error.message; }
    finally { busy(false); }
  });
  return { refresh };
}
