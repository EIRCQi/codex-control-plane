import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft, previewTask, setupTaskComposer} from '../public/task-composer.js';
import {builtInTemplates, renderTemplate} from '../lib/catalog.mjs';

// Exercise actual composer event handlers with a small form adapter. Rendering,
// native focus and CSS require a real browser; this adapter does not claim them.
function harness(t, {stored, confirmReplace, request = async () => ({json:async () => ({id:'created'})})} = {}) {
  class Control {
    value=''; disabled=false; hidden=false; textContent=''; open=false; listeners=new Map();
    addEventListener(type,handler) { const handlers=this.listeners.get(type)||[];handlers.push(handler);this.listeners.set(type,handlers); }
    async event(type, extra={}) { const event={target:this,preventDefault(){this.prevented=true;},...extra};for(const handler of this.listeners.get(type)||[]) await handler(event);return event; }
    focus() { this.focused=true; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  const nodes=new Map();
  const get=(key)=>{if(!nodes.has(key))nodes.set(key,new Control());return nodes.get(key);};
  const form=get('#task-form');
  form.elements={projectId:new Control(),templateId:new Control(),prompt:new Control(),mode:new Control()};
  form.elements.mode.value='implement';
  form.querySelector=()=>get('fieldset');
  form.reportValidity=()=>Boolean(form.elements.projectId.value&&form.elements.prompt.value.trim());
  form.reset=()=>Object.values(form.elements).forEach((field)=>{field.value='';});
  form.requestSubmit=()=>form.event('submit');
  const storage=new Map(stored?[['codex-control-plane.task-draft.v1',JSON.stringify(stored)]]:[]);
  const previous={document:global.document,localStorage:global.localStorage};
  global.document={querySelector:get,querySelectorAll:()=>[get('#close-dialog'),get('#cancel-dialog')]};
  global.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  t.after(()=>{global.document=previous.document;global.localStorage=previous.localStorage;});
  const created=[],messages=[];
  const composer=setupTaskComposer({request,confirmReplace,onCreated:async run=>created.push(run),notify:message=>messages.push(message),escapeHtml:s=>s,onNeedProject:()=>messages.push('needs project')});
  composer.connectionChanged(true);
  const projects=[{id:'project-a',name:'A',branch:'main'},{id:'project-b',name:'B',branch:'main'}];
  composer.catalogChanged(projects,builtInTemplates);
  return {composer,form,get,storage,created,messages,projects,input:async(name,value)=>{form.elements[name].value=value;await form.event('input',{target:form.elements[name]});await form.event('change',{target:form.elements[name]});}};
}

test('template previews match the instructions submitted by the server', () => {
  for (const template of builtInTemplates) assert.equal(previewTask(template,'  修复 <tag> & 中文 😀  '),renderTemplate(template,'  修复 <tag> & 中文 😀  '));
  assert.deepEqual(normalizeDraft({prompt:123,projectId:[],mode:'invalid'}),{prompt:'',projectId:'',templateId:'',mode:'implement'});
});

test('draft fields and the chosen mode survive select input events and catalog reconnects', async t => {
  const h=harness(t,{stored:{projectId:'project-b',templateId:'builtin-feature',prompt:'Existing draft',mode:'implement'}});
  assert.equal(h.form.elements.prompt.value,'Existing draft');
  assert.equal(h.form.elements.projectId.value,'project-b');
  await h.input('mode','review');
  assert.equal(h.form.elements.mode.value,'review');
  await h.input('prompt','Unsaved work 中文');
  h.composer.catalogChanged(h.projects,builtInTemplates);
  assert.equal(h.form.elements.prompt.value,'Unsaved work 中文');
  assert.equal(h.form.elements.projectId.value,'project-b');
  assert.equal(h.form.elements.templateId.value,'builtin-feature');
  assert.equal(h.form.elements.mode.value,'review');
  assert.equal(JSON.parse(h.storage.get('codex-control-plane.task-draft.v1')).prompt,'Unsaved work 中文');
});

test('review templates lock the effective mode without overwriting the user preference', async t => {
  const h=harness(t);
  await h.input('templateId','builtin-review');
  assert.equal(h.form.elements.mode.disabled,true);assert.equal(h.form.elements.mode.value,'review');
  await h.input('templateId','builtin-feature');
  assert.equal(h.form.elements.mode.disabled,false);assert.equal(h.form.elements.mode.value,'implement');
});

test('failed and duplicate submissions keep the draft and release controls for retry', async t => {
  let rejectRequest, attempts=0;
  const h=harness(t,{request:()=>{attempts++;return new Promise((_,reject)=>rejectRequest=reject);}});
  await h.input('projectId','project-a');await h.input('prompt','Keep this task');
  h.composer.open();
  const pending=h.form.event('submit');
  await h.form.event('submit');
  assert.equal(attempts,1);assert.equal(h.get('fieldset').disabled,true);
  assert.equal((await h.get('#task-dialog').event('cancel')).prevented,true);
  rejectRequest(new Error('Runner unavailable'));await pending;
  assert.equal(h.get('fieldset').disabled,false);assert.equal(h.form.elements.prompt.value,'Keep this task');
  assert.equal(h.get('#form-error').textContent,'Runner unavailable');assert.equal(h.get('#task-dialog').open,true);
});

test('success submits the effective review mode and clears the draft only after acceptance', async t => {
  let body;
  const h=harness(t,{request:async(_,options)=>{body=JSON.parse(options.body);return {json:async()=>({id:'accepted'})};}});
  await h.input('projectId','project-a');await h.input('templateId','builtin-review');await h.input('prompt','Review this');
  h.composer.open();await h.form.event('submit');
  assert.equal(body.mode,'review');assert.equal(body.prompt,'Review this');
  assert.equal(h.storage.has('codex-control-plane.task-draft.v1'),false);
  assert.equal(h.get('#task-dialog').open,false);assert.deepEqual(h.created,[{id:'accepted'}]);
  h.composer.connectionChanged(false);assert.equal(h.get('#start-task').disabled,true);
});

test('reuse asks before replacing an existing draft, and never submits a task automatically', async t => {
  let allow=false,requests=0;
  const h=harness(t,{stored:{projectId:'project-a',prompt:'Keep my draft'},confirmReplace:()=>allow,request:async()=>{requests++;}});
  const preset={projectId:'project-b',templateId:'builtin-review',prompt:'Review reused task',mode:'review'};
  assert.equal(h.composer.open(preset),false);assert.equal(h.form.elements.prompt.value,'Keep my draft');
  allow=true;assert.equal(h.composer.open(preset),true);
  assert.equal(h.form.elements.projectId.value,'project-b');assert.equal(h.form.elements.mode.value,'review');
  assert.equal(h.form.elements.prompt.value,'Review reused task');assert.equal(requests,0);
  assert.equal(JSON.parse(h.storage.get('codex-control-plane.task-draft.v1')).prompt,'Review reused task');
});
