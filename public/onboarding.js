import { messageText } from './locale.js';

export function setupOnboarding({request, notify, onEnvironment, onProject, onTask, onSignedIn, onBusyChange, onReadiness = () => {}}) {
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
  const labels = {unknown:'尚未检查登录', checking:'正在检查登录……', missing:'请先安装 Codex', signed_out:'需要登录', signed_in:'已登录', starting:'正在准备登录……', waiting:'等待浏览器授权', verifying:'正在确认登录……', cancelling:'正在停止登录……', cancelled:'登录已取消', timed_out:'登录超时', error:'登录需要处理'};
  function render() {
    status.textContent = connected ? labels[state.state] || '尚未检查登录' : '执行器连接已断开';
    status.className = `setup-status ${state.state === 'signed_in' ? 'ok' : 'attention'}`;
    message.textContent = messageText(state.message) || '使用你的 ChatGPT 账号，在浏览器中完成授权。';
    login.hidden = state.state === 'signed_in' || state.busy;
    login.disabled = !connected || pending || state.state === 'missing';
    cancel.hidden = !state.busy;
    cancel.disabled = !connected || pending || state.state === 'cancelling';
    refreshButton.disabled = !connected || pending || state.busy;
    link.hidden = !connected || !state.busy || !state.loginUrl;
    if (!link.hidden) link.href = state.loginUrl; else link.removeAttribute('href');
    const toolsReady = report?.git.status === 'ok' && report?.codex.status === 'ok' && report?.storage.status === 'ok';
    document.querySelector('#setup-tools-state').textContent = report ? toolsReady ? '本地工具已就绪' : '运行环境需要处理' : '正在检查本地工具……';
    document.querySelector('#setup-account-state').textContent = state.state === 'signed_in' ? '本地登录凭据可用' : state.busy ? '请在浏览器中完成授权' : '连接你的 Codex 账号';
    document.querySelector('#setup-project-state').textContent = projectCount ? `已添加 ${projectCount} 个项目` : '添加本地 Git 仓库';
    projectButton.textContent = projectCount ? '新建任务' : '添加项目';
    projectButton.disabled = !connected || state.busy;
    panel.dataset.ready = String(Boolean(toolsReady && state.state === 'signed_in' && projectCount));
    document.querySelector('#setup-title').textContent = panel.dataset.ready === 'true' ? '可以开始下一个任务了' : '开始使用 Codex';
    onReadiness({ready: panel.dataset.ready === 'true', connected, busy: state.busy});
  }
  function accept(next) {
    if (next.instanceId === state.instanceId && next.revision < state.revision) return;
    const previous = state;
    state = next;
    onBusyChange(Boolean(state.busy));
    render();
    if (previous.busy && state.state === 'signed_in') {
      notify('Codex 登录已就绪');
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
    } catch (failure) { if (current === generation) error.textContent = messageText(failure.message); }
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
