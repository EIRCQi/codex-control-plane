import { agentOutput } from './run-output.js';

const states = new Set(['', 'active', 'approvals', 'queued', 'running', 'approved', 'awaiting_approval', 'awaiting_merge', 'completed', 'failed', 'cancelled', 'discarded', 'budget_exceeded']);
const sorts = new Set(['created', 'updated', 'tokens', 'attention']);
export function normalizeFilters(value = {}) {
  return {
    query: typeof value?.query === 'string' ? value.query : '',
    state: states.has(value?.state) ? value.state : '',
    projectId: typeof value?.projectId === 'string' ? value.projectId : '',
    archived: value?.archived === true,
    sort: sorts.has(value?.sort) ? value.sort : 'created',
  };
}
export const taskTitle = run => run.task || run.prompt || '';
const attention = state => ['awaiting_approval', 'awaiting_merge'].includes(state) ? 0 : ['failed', 'budget_exceeded'].includes(state) ? 1 : ['running', 'queued', 'approved'].includes(state) ? 2 : 3;
export function selectRuns(runs, filters, projects = []) {
  const { query, state, projectId, archived, sort } = normalizeFilters(filters);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const names = new Map(projects.map(project => [project.id, project.name]));
  return runs.filter(run => {
    if (Boolean(run.archived) !== archived || (projectId && run.projectId !== projectId)) return false;
    if (state === 'active' && !['queued', 'running', 'approved'].includes(run.state)) return false;
    if (state === 'approvals' && !['awaiting_approval', 'awaiting_merge'].includes(run.state)) return false;
    if (state && !['active', 'approvals'].includes(state) && run.state !== state) return false;
    const text = `${taskTitle(run)} ${run.prompt} ${run.repository} ${names.get(run.projectId) || ''} ${run.id}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => {
    const order = sort === 'tokens' ? (b.usage?.totalTokens || 0) - (a.usage?.totalTokens || 0)
      : sort === 'attention' ? attention(a.state) - attention(b.state)
      : sort === 'updated' ? (b.updatedAt || '').localeCompare(a.updatedAt || '') : 0;
    return order || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
}

// Full prompts from older runs have already had their template applied.
// Reuse them verbatim if the original template input cannot be recovered.
export function draftFromRun(run, projects, templates) {
  const project = projects.find(item => item.id === run.projectId && item.repository === run.repository) || projects.find(item => item.repository === run.repository);
  if (!project) return null;
  const template = templates.find(item => item.id === run.templateId);
  const original = typeof run.task === 'string' && (!run.templateId || template?.prompt === run.templatePrompt);
  return { projectId: project.id, templateId: original ? run.templateId || '' : '', prompt: original ? run.task : run.prompt, mode: run.mode === 'review' ? 'review' : 'implement' };
}

// Log-only events must not rebuild the full usage table.
export function usageKey(runs) {
  return JSON.stringify(runs.map(run => [run.id, taskTitle(run), run.usage]));
}

export function runDownload(run, type) {
  const id = String(run.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  if (type === 'diff') return { name: `codex-${id}.patch`, type: 'text/plain;charset=utf-8', text: run.diff || '' };
  return { name: `codex-${id}.md`, type: 'text/markdown;charset=utf-8', text: agentOutput(run.output || '') };
}

export function downloadFile(file, doc = document) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const link = doc.createElement('a');
  link.href = url; link.download = file.name; link.hidden = true;
  try { doc.body.append(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
