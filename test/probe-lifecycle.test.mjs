import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {probe} from '../lib/runtime.mjs';
import {createAuthManager} from '../lib/auth.mjs';
import {until} from '../test-support/runner.mjs';

async function within(promise, ms, label) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(label)), ms);})]);}
  finally {clearTimeout(timer);}
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccp-probe-'));
  const parent = path.join(dir, 'parent.json'), worker = path.join(dir, 'worker.json');
  const ticks = path.join(dir, 'ticks'), script = path.join(dir, 'probe.cjs');
  t.after(async () => {
    for (const file of [worker, parent]) {
      try {process.kill(JSON.parse(await readFile(file, 'utf8')).pid, 'SIGKILL');} catch {}
    }
    await delay(50);
    await rm(dir, {recursive:true, force:true});
  });
  const descendant = path.join(dir, 'worker.cjs');
  await writeFile(descendant, `const fs=require('node:fs');let n=0;
process.on('SIGTERM',()=>{});
fs.writeFileSync(${JSON.stringify(worker)},JSON.stringify({pid:process.pid}));
const tick=()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n));tick();setInterval(tick,20);
if(process.send)process.send('ready');
setTimeout(()=>process.exit(0),12000);
`);
  await writeFile(script, `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(parent)},JSON.stringify({pid:process.pid}));
if(process.env.CCP_PROBE_TREE==='1'){
  const worker=require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});
  worker.on('message',()=>{if(process.env.CCP_PROBE_EXIT==='1')process.exit(0);});
}
setInterval(()=>{},1000);
`);
  const ready = () => until(async () => {try {return await readFile(ticks, 'utf8');} catch {return false;}}, 'probe descendant', 4000);
  const stopped = async () => {await delay(60);const before = await readFile(ticks, 'utf8');await delay(120);assert.equal(await readFile(ticks, 'utf8'), before);};
  return {dir, parent, script, ready, stopped};
}

test('an already-cancelled probe never launches an executable', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  const result = await probe(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(f.parent)},JSON.stringify({pid:process.pid}))`], {signal:controller.signal});
  assert.equal(result.ok, false); assert.equal(result.reason, 'ABORTED');
  await assert.rejects(access(f.parent), {code:'ENOENT'});
});

test('a timed-out probe stops descendants that inherit its output pipes', {timeout:9000}, async t => {
  const f = await fixture(t);
  const pending = probe(process.execPath, [f.script], {env:{...process.env, CCP_PROBE_TREE:'1'}, timeoutMs:1500, killAfterMs:80});
  await f.ready();
  const result = await within(pending, 3500, 'Probe remained blocked after its timeout');
  assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.ok, false);
  await f.stopped();
});

test('a successful probe reaps lingering POSIX descendants before returning', {skip:process.platform === 'win32', timeout:7000}, async t => {
  const f = await fixture(t);
  const pending = probe(process.execPath, [f.script], {env:{...process.env, CCP_PROBE_TREE:'1', CCP_PROBE_EXIT:'1'}, timeoutMs:5000, killAfterMs:80});
  await f.ready();
  const result = await within(pending, 1500, 'Successful probe retained descendant pipes');
  assert.equal(result.ok, true); assert.equal(result.reason, null);
  await f.stopped();
});

test('cancelling login waits for the owned process tree instead of only its leader', {timeout:7000}, async t => {
  const f = await fixture(t);
  const manager = createAuthManager({
    getExecutable:async () => process.execPath, env:{...process.env, CCP_PROBE_TREE:'1'}, killAfterMs:80,
    probeLogin:async () => ({ok:false, code:1, reason:'EXIT_ERROR'}),
    spawnProcess:(command, args, options) => spawn(command, [f.script], options),
  });
  t.after(() => manager.shutdown());
  manager.start(); await f.ready();
  const result = await within(manager.cancel(), 3500, 'Login cancellation remained blocked by descendants');
  assert.equal(result.state, 'cancelled'); assert.equal(result.busy, false);
  await f.stopped();
});

test('shutdown aborts credential refresh probes without publishing a late result', {timeout:7000}, async t => {
  const f = await fixture(t); const updates = [];
  const manager = createAuthManager({
    getExecutable:async () => process.execPath, env:process.env,
    probeLogin:(command, args, options) => probe(command, [f.script], {...options, timeoutMs:20000, killAfterMs:80}),
    onChange:value => updates.push(value),
  });
  t.after(() => manager.shutdown());
  const refreshing = manager.refresh();
  await until(async () => {try {await access(f.parent);return true;} catch {return false;}}, 'credential probe');
  const count = updates.length;
  await within(manager.shutdown(), 3500, 'Shutdown did not cancel the credential probe');
  await refreshing; assert.equal(updates.length, count);
});

test('cancelling login aborts its in-progress credential preflight', {timeout:7000}, async t => {
  const f = await fixture(t);
  const manager = createAuthManager({
    getExecutable:async () => process.execPath, env:process.env,
    probeLogin:(command, args, options) => probe(command, [f.script], {...options, timeoutMs:20000, killAfterMs:80}),
    spawnProcess:() => assert.fail('Cancelled preflight must never launch login'),
  });
  t.after(() => manager.shutdown());
  manager.start();
  await until(async () => {try {await access(f.parent);return true;} catch {return false;}}, 'login preflight');
  const result = await within(manager.cancel(), 3500, 'Cancellation did not abort the login preflight');
  assert.equal(result.state, 'cancelled'); assert.equal(result.busy, false);
});
