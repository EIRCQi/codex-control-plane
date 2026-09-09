export function setupOnboarding({request, notify, onEnvironment, onProject, onTask, onSignedIn, onBusyChange}) {
  const panel = document.querySelector('#setup-panel');
  const status = document.querySelector('#login-status');
  const message = document.querySelector('#login-message');
  const error = document.querySelector('#login-error');
  const login = document.querySelector('#login-codex');
  const cancel = document.querySelector('#cancel-login');
  const refreshButton = document.querySelector('#refresh-login');
  const link = document.querySelector('#login-link');
  const projectButton = document.querySelector('#setup-project');
  let state = {state:'unknown', busy:false}, report = null, projectCount = 0;
  let connected = false, pending = false, generation = 0, lastChecked = 0, refreshRequested = false;
  const labels = {unknown:'Login not checked', checking:'Checking login…', missing:'Install Codex first', signed_out:'Sign in required', signed_in:'Signed in', starting:'Preparing login…', waiting:'Waiting for browser', verifying:'Confirming login…', cancelling:'Stopping login…', cancelled:'Login cancelled', timed_out:'Login timed out', error:'Login needs attention'};
  function render() {
    status.textContent = connected ? labels[state.state] || 'Login not checked' : 'Runner disconnected';
    status.className = `setup-status ${state.state === 'signed_in' ? 'ok' : 'attention'}`;
    message.textContent = state.message || 'Use your existing ChatGPT account. Complete authorization in your browser.';
    login.hidden = state.state === 'signed_in' || state.busy;
    login.disabled = !connected || pending || state.state === 'missing';
    cancel.hidden = !state.busy;
    cancel.disabled = !connected || pending || state.state === 'cancelling';
    refreshButton.disabled = !connected || pending || state.busy;
    link.hidden = !connected || !state.busy || !state.loginUrl;
    if (!link.hidden) link.href = state.loginUrl; else link.removeAttribute('href');
    const toolsReady = report?.git.status === 'ok' && report?.codex.status === 'ok' && report?.storage.status === 'ok';
    document.querySelector('#setup-tools-state').textContent = report ? toolsReady ? 'Local tools ready' : 'Setup needs attention' : 'Checking local tools…';
    document.querySelector('#setup-account-state').textContent = state.state === 'signed_in' ? 'Credentials available' : state.busy ? 'Complete browser authorization' : 'Connect your Codex account';
    document.querySelector('#setup-project-state').textContent = projectCount ? `${projectCount} registered ${projectCount === 1 ? 'project' : 'projects'}` : 'Register a local Git repository';
    projectButton.textContent = projectCount ? 'Create a task' : 'Add project';
    projectButton.disabled = !connected || state.busy;
    panel.dataset.ready = String(Boolean(toolsReady && state.state === 'signed_in' && projectCount));
    document.querySelector('#setup-title').textContent = panel.dataset.ready === 'true' ? 'Ready for your next task' : 'Get ready to run Codex';
  }
  function accept(next) {
    if (next.instanceId === state.instanceId && next.revision < state.revision) return;
    const previous = state;
    state = next;
    onBusyChange(Boolean(state.busy));
    render();
    if (previous.busy && state.state === 'signed_in') {
      notify('Codex login is ready');
      onSignedIn();
    }
    if (refreshRequested) scheduleRefresh();
  }
  function scheduleRefresh() {
    refreshRequested = true;
    if (!connected || pending || state.busy) return;
    refreshRequested = false;
    void operation('/api/auth/refresh');
  }
  async function operation(path) {
    if (!connected || pending) return;
    const current = generation;
    pending = true; error.textContent = ''; render();
    try {
      const next = await request(path, {method:'POST'}).then(response => response.json());
      if (current === generation) { lastChecked = Date.now(); accept(next); }
    } catch (failure) { if (current === generation) error.textContent = failure.message; }
    finally { pending = false; render(); if (refreshRequested) scheduleRefresh(); }
  }
  login.addEventListener('click', () => { void operation('/api/auth/login'); });
  cancel.addEventListener('click', () => { void operation('/api/auth/cancel'); });
  refreshButton.addEventListener('click', () => { void operation('/api/auth/refresh'); });
  document.querySelector('#setup-environment').addEventListener('click', onEnvironment);
  projectButton.addEventListener('click', () => projectCount ? onTask() : onProject());
  window.addEventListener('focus', () => { if (connected && !state.busy && Date.now() - lastChecked > 30000) scheduleRefresh(); });
  render();
  return {
    accept,
    connectionChanged(value) { connected = value; generation++; render(); if (value) scheduleRefresh(); },
    environmentChanged(value) { report = value; render(); scheduleRefresh(); },
    projectsChanged(value) { projectCount = value.length; render(); },
  };
}
