const pages = {
  'runs-panel': ['任务控制台', '查看执行进度，处理审批，回看每一次任务结果。'],
  'catalog-panel': ['项目与模板', '管理本地仓库，复用常用任务指令。'],
  'usage-panel': ['用量统计', '查看 Token 构成、模型用量和任务消耗。'],
  'environment-panel': ['环境检查', '检查本地工具，配置 Git 与 Codex 的程序路径。'],
  'budget-settings': ['设置', '调整任务预算和并发上限。'],
  'setup-panel': ['登录与使用', '连接 Codex 账号，了解从创建任务到审批变更的用法。'],
};

// Sections stay mounted: changing pages must not discard drafts or live state.
export function setupWorkspace({root = document, view = window, onChange = () => {}} = {}) {
  const sections = new Map([...root.querySelectorAll('[data-workspace]')].map(node => [node.dataset.workspace, node]));
  const title = root.querySelector('#workspace-title');
  const description = root.querySelector('#workspace-description');
  const positions = new Map();
  let current = null, approvals = false;
  const valid = name => Object.hasOwn(pages, name) && sections.has(name);
  const fromLocation = () => {
    try { const name = decodeURIComponent(view.location.hash.slice(1)); return valid(name) ? name : 'runs-panel'; }
    catch { return 'runs-panel'; }
  };
  function headings() {
    const isApproval = current === 'runs-panel' && approvals;
    const [heading, copy] = isApproval ? ['审批中心', '阅读分析方案或代码补丁，再决定是否批准下一步。'] : pages[current];
    title.textContent = heading; description.textContent = copy;
    root.title = `${heading} · Codex 控制台`;
    for (const button of root.querySelectorAll('.nav')) {
      const active = isApproval ? button.id === 'approvals-nav' || button.dataset.filterNav === 'approvals' : button.dataset.target === current;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
  }
  function navigate(name, {focus = true, history = 'push'} = {}) {
    if (!valid(name)) return false;
    const changed = name !== current;
    if (changed && current) positions.set(current, view.scrollY || 0);
    current = name;
    for (const [key, section] of sections) section.hidden = key !== name;
    if (history !== 'none' && view.location.hash !== `#${name}`) {
      view.history[history === 'replace' ? 'replaceState' : 'pushState'](null, '', `#${name}`);
    }
    headings();
    if (changed) view.scrollTo({top: positions.get(name) || 0, left: 0, behavior: 'auto'});
    if (focus) title.focus({preventScroll: true});
    if (changed) onChange(name);
    return true;
  }
  const restore = () => { const name = fromLocation(); if (name !== current) navigate(name, {history:'none'}); };
  view.addEventListener('popstate', restore);
  view.addEventListener('hashchange', restore);
  if ('scrollRestoration' in view.history) view.history.scrollRestoration = 'manual';
  // Initial render intentionally avoids moving focus or calling app callbacks.
  const initial = fromLocation();
  current = initial;
  for (const [key, section] of sections) section.hidden = key !== initial;
  if (view.location.hash !== `#${initial}`) view.history.replaceState(null, '', `#${initial}`);
  headings();
  return {navigate, current: () => current, setTaskContext(value) {approvals = value; headings();}};
}
