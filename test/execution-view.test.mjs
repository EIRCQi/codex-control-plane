import test from 'node:test';
import assert from 'node:assert/strict';
import { setupExecutionView } from '../public/execution-view.js';
import { runDownload } from '../public/run-view.js';

test('reading an earlier execution stays selected during live updates; exports use the chosen report', () => {
  class Element {
    children=[];value='';textContent='';listeners=new Map();dataset={};
    setAttribute(name,value){this[name]=value;}
    addEventListener(type,fn){this.listeners.set(type,fn);}event(type){this.listeners.get(type)?.();}
    replaceChildren(){this.children=[];}append(node){this.children.push(node);}
  }
  const nodes=new Map();const get=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  const buttons=[new Element(),new Element()];
  const root={ownerDocument:{createElement:()=>new Element()},querySelector:get,querySelectorAll:selector=>selector==='[data-report-mode]'?[]:buttons};
  const view=setupExecutionView(root);
  const first={seq:1,phase:'analysis',status:'failed',output:'<script>中文报告</script>',diagnostics:'failure details'};
  let run={id:'a',output:'latest',executions:[first,{seq:2,phase:'analysis',status:'running',output:'new partial'}]};
  view.update(run);assert.equal(view.report(),'new partial');
  get('[data-execution-select]').value='1';get('[data-execution-select]').event('change');
  assert.equal(view.report(),first.output);assert.equal(get('[data-execution-report]').textContent,first.output);
  run={...run,executions:[first,{seq:2,phase:'analysis',status:'completed',output:'new finished'}]};
  view.update(run);assert.equal(view.sequence(),1);assert.equal(view.report(),first.output);
  const file=runDownload(run,'output',{output:view.report(),executionSeq:view.sequence()});
  assert.equal(file.text,first.output);assert.match(file.name,/-execution-1\.md$/);
  view.update({id:'b',output:'old plain report'});assert.equal(view.report(),'old plain report');assert.equal(get('[data-execution-select]').value,'latest');
  assert.ok(buttons.every(button=>!button.disabled));
});
