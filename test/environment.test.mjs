import test from 'node:test';
import assert from 'node:assert/strict';
import { setupEnvironment } from '../public/environment.js';

function harness(t, request) {
  class Element {
    value='';disabled=false;readOnly=false;listeners=new Map();
    addEventListener(type,fn) { this.listeners.set(type,fn); }
    event(type) { return this.listeners.get(type)?.({preventDefault(){}}); }
    setAttribute() {}
  }
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const form=get('#runtime-settings');form.elements={gitPath:new Element(),codexPath:new Element()};
  const controls=[...Object.values(form.elements),get('#refresh-environment')];
  get('#environment-panel').querySelectorAll=()=>controls;
  const original=global.document;global.document={querySelector:get};t.after(()=>global.document=original);
  const controller=setupEnvironment({request,escapeHtml:s=>s});
  return {controller,form,get,controls};
}
const reply=value=>({json:async()=>value});
const report={version:'0.6.0',ready:true,checkedAt:'2026-09-10',git:{status:'ok'},codex:{status:'ok'},authentication:{status:'ok'},storage:{status:'ok'}};

test('environment refresh preserves edited paths and saving cannot race another save or refresh', async t => {
  let puts=0,release;
  let settings={gitPath:'',codexPath:'/original',overrides:{}};
  const h=harness(t,async(url,options)=>{
    if(options?.method==='PUT') { puts++;await new Promise(resolve=>release=resolve);settings={...JSON.parse(options.body),overrides:{}};return reply(settings); }
    return reply(url==='/api/runtime'?settings:report);
  });
  await h.controller.refresh();
  h.form.elements.codexPath.value='/draft 中文';h.form.event('input');
  await h.controller.refresh();assert.equal(h.form.elements.codexPath.value,'/draft 中文');
  const saving=h.form.event('submit');h.form.event('submit');const refreshing=h.controller.refresh();
  await Promise.resolve();assert.equal(puts,1);assert.ok(h.controls.every(control=>control.disabled));
  release();await Promise.all([saving,refreshing]);assert.ok(h.controls.every(control=>!control.disabled));
  assert.equal(h.form.elements.codexPath.value,'/draft 中文');assert.equal(settings.codexPath,'/draft 中文');
});

test('failed path saves keep the draft and restore controls', async t => {
  const h=harness(t,async(url,options)=>{if(options?.method==='PUT')throw new Error('save failed');return reply(url==='/api/runtime'?{gitPath:'',codexPath:'',overrides:{}}:report);});
  await h.controller.refresh();h.form.elements.codexPath.value='/keep';h.form.event('input');
  await h.form.event('submit');assert.equal(h.get('#environment-status').textContent,'save failed');
  assert.equal(h.form.elements.codexPath.value,'/keep');assert.ok(h.controls.every(control=>!control.disabled));
});
