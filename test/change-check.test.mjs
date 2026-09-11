import test from 'node:test';
import assert from 'node:assert/strict';
import { setupChangeCheck } from '../public/change-check.js';

function harness(request,timeoutMs) {
  const button={disabled:true,addEventListener(type,fn){this.click=fn;}};
  const status={textContent:''};
  const root={querySelector:selector=>selector==='[data-check-changes]'?button:status};
  return {controller:setupChangeCheck({root,request,timeoutMs}),button,status};
}
const run={id:'a',revision:2,state:'awaiting_merge',runnerId:'one'};
test('change checks prevent duplicate clicks and ignore a result for an old task or revision', async () => {
  let calls=0,resolve,signal;
  const h=harness((url,options)=>{calls++;signal=options.signal;return new Promise(done=>resolve=done);});
  h.controller.update(run,true);const pending=h.button.click();await h.button.click();assert.equal(calls,1);
  h.controller.update({...run,id:'b'},true);assert.equal(signal.aborted,true);
  resolve({ok:true,json:async()=>({revision:2,canApply:true})});await pending;
  assert.doesNotMatch(h.status.textContent,/检查通过/);assert.equal(h.button.disabled,false);
  const next=h.button.click();resolve({ok:true,json:async()=>({revision:1,canApply:true})});await next;
  assert.match(h.status.textContent,/状态已改变/);
  h.controller.update({...run,state:'completed'},true);assert.equal(h.button.disabled,true);
});
test('a stalled change check times out and restores its button without applying anything', async () => {
  const h=harness((url,options)=>new Promise((resolve,reject)=>{assert.match(url,/change-check$/);assert.equal(options.method,undefined);options.signal.addEventListener('abort',()=>reject(new Error('aborted')));}),10);
  h.controller.update(run,true);await h.button.click();assert.match(h.status.textContent,/检查超时/);assert.equal(h.button.disabled,false);
});
