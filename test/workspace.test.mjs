import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorkspace } from '../public/workspace.js';

function harness(hash = '') {
  const sections = ['runs-panel','catalog-panel','usage-panel','environment-panel','budget-settings','setup-panel'].map(name=>({dataset:{workspace:name},hidden:false,draft:{value:'未保存的输入'}}));
  const title = {focus(){this.focused=true;}}, description = {}, listeners = new Map(), entries = [];
  const navigation = sections.map(section=>({dataset:{target:section.dataset.workspace},attrs:{},classList:{toggle(name,value){this[name]=value;}},setAttribute(name,value){this.attrs[name]=value;},removeAttribute(name){delete this.attrs[name];}}));
  navigation.push({id:'approvals-nav',dataset:{},attrs:{},classList:{toggle(name,value){this[name]=value;}},setAttribute(name,value){this.attrs[name]=value;},removeAttribute(name){delete this.attrs[name];}});
  const root={querySelectorAll:selector=>selector==='[data-workspace]'?sections:navigation,querySelector:selector=>selector==='#workspace-title'?title:description};
  const view={location:{hash},scrollY:0,history:{scrollRestoration:'auto',pushState(state,unused,url){entries.push(url);view.location.hash=url;},replaceState(state,unused,url){view.location.hash=url;}},addEventListener:(name,fn)=>listeners.set(name,fn),scrollTo({top}){this.scrollY=top;}};
  const controller=setupWorkspace({root,view});
  return {controller,root,view,sections,title,navigation,entries,visit(hash,event='popstate'){view.location.hash=hash;listeners.get(event)();}};
}
test('workspace navigation keeps forms mounted and restores page scroll during browser history', () => {
  const h=harness();const saved=h.sections[1].draft;
  h.view.scrollY=240;h.controller.navigate('catalog-panel');
  assert.deepEqual(h.sections.filter(x=>!x.hidden).map(x=>x.dataset.workspace),['catalog-panel']);
  assert.equal(h.view.scrollY,0);h.view.scrollY=120;
  h.visit('#runs-panel');assert.equal(h.view.scrollY,240);
  h.visit('#catalog-panel');assert.equal(h.view.scrollY,120);assert.equal(h.sections[1].draft,saved);assert.equal(saved.value,'未保存的输入');
  assert.equal(h.entries.length,1);assert.equal(h.title.focused,true);assert.equal(h.view.history.scrollRestoration,'manual');
});
test('direct settings links and approval titles match the visible page', () => {
  const h=harness('#budget-settings');assert.equal(h.controller.current(),'budget-settings');assert.equal(h.title.textContent,'设置');
  h.controller.setTaskContext(true);assert.equal(h.title.textContent,'设置');
  h.controller.navigate('runs-panel');assert.equal(h.title.textContent,'审批中心');assert.equal(h.navigation.at(-1).attrs['aria-current'],'page');
  h.controller.setTaskContext(false);assert.equal(h.title.textContent,'任务控制台');assert.equal(h.navigation.at(-1).attrs['aria-current'],undefined);
});
test('unknown and malformed hashes fall back without allowing an arbitrary selector', () => {
  const h=harness('#%ZZ');assert.equal(h.controller.current(),'runs-panel');
  assert.equal(h.controller.navigate('__proto__'),false);assert.equal(h.controller.navigate('runs-panel]script'),false);
  h.controller.navigate('setup-panel');h.visit('#not-a-page','hashchange');assert.equal(h.controller.current(),'runs-panel');
});
