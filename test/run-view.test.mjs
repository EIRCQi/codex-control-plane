import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRuns, normalizeFilters, draftFromRun, usageKey, runDownload } from '../public/run-view.js';

const projects = [{id:'project', repository:'/repo', name:'控制台'}];
const template = {id:'template', prompt:'Review {{task}}'};
const run = {id:'run', projectId:'project', repository:'/repo', task:'Fix 中文', prompt:'Review Fix 中文', templateId:'template', templatePrompt:template.prompt, state:'completed', mode:'review', createdAt:'2026-09-10', updatedAt:'2026-09-10', usage:{totalTokens:50}};

test('search matches project names and multiple terms, filters legacy records, and sorts without mutating source', () => {
  const runs = [run, {...run, id:'next', task:'Other', prompt:'Other', state:'awaiting_approval', createdAt:'2026-09-11', usage:{totalTokens:10}}, {...run,id:'archive',archived:true}];
  assert.deepEqual(selectRuns(runs,{query:'控制台 中文'},projects).map(r=>r.id),['run']);
  assert.deepEqual(selectRuns(runs,{sort:'attention'}).map(r=>r.id),['next','run']);
  assert.deepEqual(selectRuns(runs,{sort:'tokens'}).map(r=>r.id),['run','next']);
  assert.deepEqual(selectRuns(runs,{state:'approvals'}).map(r=>r.id),['next']);
  assert.deepEqual(selectRuns(runs,{archived:true}).map(r=>r.id),['archive']);
  assert.deepEqual(runs.map(r=>r.id),['run','next','archive']);
  assert.deepEqual(normalizeFilters({query:[],archived:'false',sort:'__proto__',state:null}),{query:'',archived:false,sort:'created',state:'',projectId:''});
});

test('task reuse preserves mode and avoids applying templates twice, including removed templates and legacy runs', () => {
  assert.deepEqual(draftFromRun(run,projects,[template]),{projectId:'project',templateId:'template',prompt:'Fix 中文',mode:'review'});
  for (const templates of [[],[{...template,prompt:'Changed {{task}}'}]]) {
    const draft=draftFromRun(run,projects,templates);
    assert.equal(draft.templateId,'');assert.equal(draft.prompt,run.prompt);assert.equal(draft.mode,'review');
  }
  assert.equal(draftFromRun({...run,task:undefined},projects,[template]).prompt,run.prompt);
  assert.equal(draftFromRun(run,[{...projects[0],repository:'/different'}],[template]),null);
  assert.equal(draftFromRun(run,[{...projects[0],id:'registered-again'}],[template]).projectId,'registered-again');
});

test('log-only events do not invalidate usage; report and patch downloads preserve their content', () => {
  assert.equal(usageKey([run]),usageKey([{...run,logs:[{message:'new log'}],updatedAt:'later'}]));
  assert.notEqual(usageKey([run]),usageKey([{...run,usage:{totalTokens:51}}]));
  const diff='diff --git a/中文.txt b/中文.txt\n+hello\n';
  assert.equal(runDownload({...run,diff},'diff').text,diff);
  const output=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'# 中文报告\n\nDetails'}});
  assert.equal(runDownload({...run,output},'output').text,'# 中文报告\n\nDetails');
  assert.equal(runDownload({...run,id:'../../bad?name'},'output').name,'codex-______bad_name.md');
});
