import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopRunner, desktopWindowOptions, trayMenu } from "../lib/desktop.mjs";
import { selectRunner } from '../lib/launcher.mjs';
import { setImmediate } from 'node:timers/promises';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('quitting before desktop startup prevents loading a Runner', async () => {
  const runner=createDesktopRunner({port:0,load:()=>assert.fail('startup after quit')});
  await runner.shutdown();
  assert.equal(await runner.start(),null);
  assert.equal(runner.stopping,true);
});

test('quitting during a port probe prevents a late Runner launch', async () => {
  const probe=deferred();
  const runner=createDesktopRunner({port:4310,select:options=>selectRunner({...options,inspect:()=>probe.promise}),load:()=>assert.fail('late startup after quit')});
  const starting=runner.start(),stopping=runner.shutdown();
  const rejected=assert.rejects(starting,/Desktop runner is stopping/);
  probe.resolve(null);
  await rejected;await stopping;
});

for(const stage of ['module import','initialization'])test(`desktop quit during ${stage} cancels startup and waits for cleanup`, async () => {
  const loading=deferred(),ready=deferred(),cleanup=deferred();let stops=0,closed=false;
  const server={serverReady:ready.promise,shutdown:()=>{stops++;ready.reject(new Error('Startup cancelled'));return cleanup.promise;}};
  const runner=createDesktopRunner({port:0,load:()=>loading.promise});
  const starting=runner.start(),rejected=assert.rejects(starting,/Startup cancelled/);
  if(stage==='initialization'){loading.resolve(server);await setImmediate();}
  const stopping=runner.shutdown();stopping.then(()=>{closed=true;});
  assert.equal(runner.shutdown(),stopping);
  if(stage==='module import')loading.resolve(server);
  await rejected;await setImmediate();
  assert.equal(stops,1);assert.equal(closed,false,'quit must await subprocess and disk cleanup');
  cleanup.resolve();await stopping;
  assert.equal(closed,true);assert.equal(await runner.start(),null);assert.equal(stops,1);
});

test('a ready desktop Runner shuts down once and preserves cleanup failures', async () => {
  let loads=0,stops=0;const failure=new Error('Final save failed');
  const runner=createDesktopRunner({port:0,load:async()=>{
    loads++;
    return {serverReady:Promise.resolve({url:'http://127.0.0.1:12345'}),shutdown:async()=>{stops++;throw failure;}};
  }});
  const starting=runner.start();assert.equal(runner.start(),starting);
  assert.equal((await starting).reused,false);
  await assert.rejects(runner.shutdown(),error=>error===failure);
  await assert.rejects(runner.shutdown(),error=>error===failure);
  assert.equal(loads,1);assert.equal(stops,1);
});

test('desktop quit never takes shutdown ownership of a reused Runner', async () => {
  const probe=deferred();
  const runner=createDesktopRunner({port:4310,select:options=>selectRunner({...options,inspect:()=>probe.promise}),load:()=>assert.fail('must reuse the external Runner')});
  const starting=runner.start(),stopping=runner.shutdown();
  probe.resolve({ready:true,version:'0.9.4'});
  assert.equal(await starting,null,'quit suppresses late window creation');
  await stopping;
});

test("desktop window keeps renderer privileges isolated", () => {
  const options = desktopWindowOptions("icon");
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
});

test("tray menu reflects window visibility and exposes explicit quit", () => {
  assert.equal(trayMenu({ visible: true }).find((item) => item.id === "toggle").label, "隐藏控制台");
  const hidden = trayMenu({ visible: false });
  assert.equal(hidden.find((item) => item.id === "toggle").label, "显示控制台");
  assert.ok(hidden.some((item) => item.id === "quit"));
});
