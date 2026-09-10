import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventBuffer, createEventViewer} from '../public/event-viewer.js';
import {captureView, restoreView} from '../public/live-view.js';

const log = (n, message = `Event ${n}`) => ({at:new Date(1000 * n).toISOString(), type:'item.completed', message});

test('paused event display stays frozen while the bounded live buffer advances', () => {
  const buffer = createEventBuffer();
  const original = Array.from({length:500}, (_,i) => log(i));
  buffer.update({id:'one',logs:original});
  buffer.setPaused(true);
  original[0].message = 'Mutated outside the viewer';
  buffer.update({id:'one',logs:Array.from({length:510}, (_,i) => log(i))});
  assert.equal(buffer.view().logs[0].message, 'Event 0');
  assert.equal(buffer.view().pending, 10);
  assert.equal(buffer.view().total, 500);
  buffer.setPaused(false);
  assert.equal(buffer.view().logs[0].message, 'Event 10');
  assert.equal(buffer.view().logs.at(-1).message, 'Event 509');
  assert.equal(buffer.view().pending, 0);
});

test('pending counts retain repeated equal events; search survives updates and resets for another task', () => {
  const buffer = createEventBuffer(), repeated = log(1,'检查 <tag>');
  buffer.update({id:'one',logs:[repeated]});
  buffer.search(' 检查 '); buffer.setPaused(true);
  buffer.update({id:'one',logs:[repeated,repeated,log(2,'Different')]});
  assert.equal(buffer.view().pending, 2);
  buffer.setPaused(false);
  assert.equal(buffer.view().logs.length, 2);
  buffer.update({id:'one',logs:[repeated,log(3,'检查 again'),log(4)]});
  assert.deepEqual(buffer.view().logs.map(item=>item.message), ['检查 <tag>','检查 again']);
  buffer.setPaused(true);
  buffer.update({id:'two',logs:[log(5)]});
  assert.equal(buffer.view().paused, false);
  assert.equal(buffer.view().logs.length, 1);
});

// A small element adapter exercises controller actions and retained node identity.
// It deliberately does not emulate browser layout, selection or native focus.
function viewerHarness() {
  class Element {
    children=[]; parent=null; textContent=''; value=''; hidden=false; scrollTop=0; scrollLeft=0; clientHeight=30; listeners=new Map(); attrs=new Map();
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    event(type) { this.listeners.get(type)?.({target:this}); }
    setAttribute(key, value) { this.attrs.set(key, value); }
    append(...nodes) { for (const node of nodes) this.insertBefore(node,null); }
    insertBefore(node, before) { node.remove(); const index=before?this.children.indexOf(before):this.children.length; this.children.splice(index,0,node); node.parent=this; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this),1); this.parent=null; } }
    get scrollHeight() { return this.children.length*30; }
  }
  const elements=new Map(['search','pause','latest','count','status','lines','empty'].map(key=>[key,new Element()]));
  const root={ownerDocument:{createElement:()=>new Element()},querySelector:selector=>elements.get(selector.slice(12,-1))};
  const viewer=createEventViewer(root,{isActive:()=>true});
  return {viewer,get:key=>elements.get(key)};
}

test('event controls retain existing rows, freeze display and resume with the latest snapshot', () => {
  const {viewer,get}=viewerHarness();
  viewer.update({id:'one',logs:[log(1,'<img src=x>'),log(2)]});
  const first=get('lines').children[0];
  viewer.update({id:'one',logs:[log(1,'<img src=x>'),log(2),log(3)]});
  assert.equal(get('lines').children[0],first);
  assert.equal(first.children[2].textContent,'<img src=x>');
  get('pause').event('click');
  viewer.update({id:'one',logs:[log(1,'<img src=x>'),log(2),log(3),log(4)]});
  assert.equal(get('lines').children.length,3);
  assert.match(get('status').textContent,/1 条新事件/);
  get('latest').event('click');
  assert.equal(get('lines').children.length,4);
  assert.equal(get('pause').attrs.get('aria-pressed'),'false');
  assert.equal(get('lines').scrollTop,get('lines').scrollHeight);
});

test('search and manual scroll remain under user control when new events arrive', () => {
  const {viewer,get}=viewerHarness();
  viewer.update({id:'one',logs:[log(1),log(2),log(3),log(4)]});
  get('lines').scrollTop=5;get('lines').event('scroll');
  viewer.update({id:'one',logs:[log(1),log(2),log(3),log(4),log(5)]});
  assert.equal(get('lines').scrollTop,5);
  get('search').value='event 2';get('search').event('input');
  viewer.update({id:'one',logs:[log(1),log(2),log(6)]});
  assert.equal(get('search').value,'event 2');assert.equal(get('lines').children.length,1);
  get('search').value='no matches';get('search').event('input');
  assert.equal(get('empty').hidden,false);
  viewer.update({id:'two',logs:[log(7)]});
  assert.equal(get('search').value,'');assert.equal(get('empty').hidden,true);
});

test('focus restoration distinguishes same-style task actions and ignores hidden scroll regions', () => {
  const makeAction=op=>({dataset:{id:'run',runAction:op},className:'secondary',matches:()=>true,focus(){focused=this;}});
  const archive=makeAction('archive'), remove=makeAction('delete');
  let focused=remove;
  const visible={dataset:{view:'report'},getClientRects:()=>[{}],scrollTop:42,scrollLeft:5};
  const hidden={dataset:{view:'diff'},getClientRects:()=>[],scrollTop:0,scrollLeft:0};
  const root={ownerDocument:{activeElement:remove},scrollTop:9,scrollLeft:0,contains:()=>true,querySelectorAll:selector=>selector==='[data-view]'?[visible,hidden]:[archive,remove]};
  const saved=captureView(root);
  assert.equal(saved.sections.has('diff'),false);
  visible.scrollTop=0;focused=archive;restoreView(root,saved);
  assert.equal(visible.scrollTop,42);assert.equal(focused,remove);
});
