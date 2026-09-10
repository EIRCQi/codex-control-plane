import { messageText } from './locale.js';

const draftKey = 'codex-control-plane.task-draft.v1';
export function normalizeDraft(value = {}) {
  return {
    projectId: typeof value?.projectId === 'string' ? value.projectId : '',
    templateId: typeof value?.templateId === 'string' ? value.templateId : '',
    prompt: typeof value?.prompt === 'string' ? value.prompt : '',
    mode: value?.mode === 'review' ? 'review' : 'implement',
  };
}
export function previewTask(template, task) {
  return template ? template.prompt.replaceAll('{{task}}', task.trim() || '{{task}}') : task.trim();
}

export function setupTaskComposer({request, onCreated, onNeedProject, escapeHtml, notify}) {
  const dialog = document.querySelector('#task-dialog');
  const form = document.querySelector('#task-form');
  const fields = form.querySelector('fieldset');
  const status = document.querySelector('#draft-status');
  const error = document.querySelector('#form-error');
  const submit = document.querySelector('#start-task');
  let projects = [], templates = [], loaded = false, busy = false, connected = false;
  let saved;
  try { saved = normalizeDraft(JSON.parse(localStorage.getItem(draftKey))); } catch { saved = normalizeDraft(); }
  let preferredMode = saved.mode;
  const values = () => normalizeDraft({projectId:form.elements.projectId.value, templateId:form.elements.templateId.value, prompt:form.elements.prompt.value, mode:preferredMode});
  function remember() {
    saved = values();
    try { localStorage.setItem(draftKey, JSON.stringify(saved)); status.textContent = '草稿已保存在当前浏览器'; }
    catch { status.textContent = '草稿保存失败，请保持当前页面打开。'; }
  }
  function sync() {
    const template = templates.find((item) => item.id === form.elements.templateId.value);
    const review = template?.mode === 'review' || preferredMode === 'review';
    form.elements.mode.value = review ? 'review' : 'implement';
    form.elements.mode.disabled = template?.mode === 'review';
    document.querySelector('#task-policy-title').textContent = review ? '只读审查' : '审批保护';
    document.querySelector('#task-policy-text').textContent = review ? 'Codex 会审查仓库的隔离副本并返回报告。此模式不会申请写入权限。' : '先阅读分析方案，再批准实施；最终应用代码变更时还需要你确认。';
    document.querySelector('#task-template-note').textContent = template?.description || '直接填写任务说明，或选择一个常用模板。';
    document.querySelector('#task-preview').textContent = previewTask(template, form.elements.prompt.value) || '填写任务说明后，可在这里预览完整指令。';
    submit.textContent = busy ? '正在创建任务……' : review ? '开始审查' : '开始分析';
    submit.disabled = busy || !connected;
  }
  function catalogChanged(nextProjects, nextTemplates) {
    const selected = loaded ? values() : saved;
    projects = nextProjects; templates = nextTemplates;
    form.elements.projectId.innerHTML = '<option value="">请选择项目……</option>' + projects.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.branch || '')}</option>`).join('');
    form.elements.templateId.innerHTML = '<option value="">不使用模板</option>' + templates.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    form.elements.projectId.value = projects.some((item) => item.id === selected.projectId) ? selected.projectId : projects.length === 1 && !selected.projectId ? projects[0].id : '';
    form.elements.templateId.value = templates.some((item) => item.id === selected.templateId) ? selected.templateId : '';
    if (!loaded) {
      form.elements.prompt.value = selected.prompt;
      if (selected.prompt) status.textContent = '已恢复之前的草稿';
    }
    const missing = (selected.projectId && !projects.some((item) => item.id === selected.projectId)) || (selected.templateId && !templates.some((item) => item.id === selected.templateId));
    if (missing) error.textContent = '草稿中的项目或模板已不可用，请重新选择后再开始。';
    loaded = true; sync();
  }
  const updateDraft = (event) => {
    if (busy) return;
    if (event.target === form.elements.mode) preferredMode = form.elements.mode.value;
    remember(); sync();
  };
  form.addEventListener('input', updateDraft);
  form.addEventListener('change', updateDraft);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !connected || !form.reportValidity()) return;
    const body = {...values(), mode:form.elements.mode.value};
    busy = true; fields.disabled = true; error.textContent = ''; sync();
    let created;
    try {
      created = await request('/api/runs', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)}).then((response) => response.json());
    } catch (failure) { error.textContent = messageText(failure.message); }
    finally { busy = false; fields.disabled = false; sync(); }
    if (!created) return;
    form.elements.prompt.value = ''; preferredMode = 'implement';
    form.elements.templateId.value = ''; saved = normalizeDraft();
    try { localStorage.removeItem(draftKey); } catch { /* The submitted task is still saved by the runner. */ }
    status.textContent = ''; sync(); dialog.close();
    await onCreated(created);
    notify('任务已加入队列');
  });
  document.querySelector('#reset-task').addEventListener('click', () => {
    if (busy) return;
    form.reset(); preferredMode = 'implement'; saved = normalizeDraft();
    try { localStorage.removeItem(draftKey); status.textContent = '草稿已清空'; }
    catch { status.textContent = '无法清空已保存的草稿'; }
    error.textContent = ''; sync(); form.elements.prompt.focus();
  });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  document.querySelectorAll('#close-dialog,#cancel-dialog').forEach((button) => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  return {
    open() {
      if (!connected) { notify('请先恢复与本地执行器的连接，再新建任务', {kind:'error'}); return; }
      if (!projects.length) { onNeedProject(); return; }
      if (!dialog.open) dialog.showModal();
      (form.elements.projectId.value ? form.elements.prompt : form.elements.projectId).focus();
    },
    catalogChanged,
    connectionChanged(value) { connected = value; sync(); },
    submit() { if (!busy && dialog.open) form.requestSubmit(); },
  };
}
