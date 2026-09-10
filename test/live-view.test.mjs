import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunList } from '../public/live-view.js';

test('unchanged summary cards retain their nodes during logs; changed states and removals still update', () => {
  const container={children:[],insertBefore(node,before) { node.remove();const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,node);node.parent=this; }};
  class Node {
    constructor(markup) { this.markup=markup;this.ownerDocument=doc; }
    querySelectorAll() { return []; }
    contains() { return false; }
    remove() { if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;} }
    replaceWith(node) { const parent=this.parent;parent.insertBefore(node,this);this.remove(); }
  }
  const doc={activeElement:null,createElement() { return {content:{},set innerHTML(value){this.content.firstElementChild=new Node(value);}}; }};
  container.ownerDocument=doc;
  const update=createRunList(container,run=>`${run.id}:${run.state}`);
  update([{id:'a',state:'running'},{id:'b',state:'queued'}]);
  const first=container.children[0],second=container.children[1];
  update([{id:'a',state:'running',logs:['new']},{id:'b',state:'queued'}]);
  assert.equal(container.children[0],first);assert.equal(container.children[1],second);
  update([{id:'b',state:'queued'},{id:'a',state:'completed'}]);
  assert.equal(container.children[0],second);assert.notEqual(container.children[1],first);
  assert.equal(container.children[1].markup,'a:completed');
  update([{id:'b',state:'queued'}]);assert.deepEqual(container.children,[second]);
});
