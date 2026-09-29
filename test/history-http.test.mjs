import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createRun} from '../lib/workflow.mjs';
import {until} from '../test-support/runner.mjs';

const options={timeout:15000};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

// Exercise the real HTTP server on every platform, with a controlled disk-write
// boundary. Terminal history has no worktrees and never invokes Git or Codex.
async function fixture(t,{archived=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ccp-history-'));
  const file=path.join(directory,'runs.json'),originalRename=fs.rename;
  const target=createRun({id:'target',repository:path.join(directory,'target-repo'),prompt:'Saved history'});
  Object.assign(target,{state:'completed',archived,usage:{...target.usage,inputTokens:10,outputTokens:5,totalTokens:15}});
  const peer=createRun({id:'peer',repository:path.join(directory,'peer-repo'),prompt:'Another history'});peer.state='completed';
  await fs.writeFile(file,JSON.stringify([target,peer]));
  const gates=[],allGates=[],listeners=new Map(['SIGINT','SIGTERM'].map(signal=>[signal,new Set(process.listeners(signal))]));
  let server;
  t.after(async()=>{
    for(const gate of allGates)gate.release();
    fs.rename=originalRename;syncBuiltinESMExports();
    try {await server?.shutdown();}
    finally {
      for(const [signal,previous] of listeners)for(const listener of process.listeners(signal))if(!previous.has(listener))process.removeListener(signal,listener);
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
  fs.rename=async(source,destination)=>{
    if(destination===file && gates.length){
      const gate=gates.shift();gate.entered.resolve();await gate.released.promise;
      if(gate.fail)throw Object.assign(new Error('Injected history save failure'),{code:'EIO'});
    }
    return originalRename(source,destination);
  };
  syncBuiltinESMExports();
  const environment={PORT:process.env.PORT,CODEX_CONTROL_PLANE_DATA_DIR:process.env.CODEX_CONTROL_PLANE_DATA_DIR};
  process.env.PORT='0';process.env.CODEX_CONTROL_PLANE_DATA_DIR=directory;
  try {server=await import(`../server.mjs?history-test=${randomUUID()}`);}
  finally {for(const [key,value] of Object.entries(environment))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const {url}=await server.serverReady;
  const request=async(route,method='GET')=>{
    const response=await fetch(url+route,{method,signal:AbortSignal.timeout(8000)});
    return {status:response.status,body:await response.json()};
  };
  return {
    server,url,request,
    saved:async()=>JSON.parse(await fs.readFile(file,'utf8')),
    pauseNextWrite(fail=false){
      const entered=deferred(),released=deferred();
      const gate={fail,entered,released,release:()=>released.resolve(),started:entered.promise};
      gates.push(gate);allGates.push(gate);return gate;
    },
    received(route){return new Promise(resolve=>{
      const accept=req=>{if(req.url===route){server.controlServer.off('request',accept);resolve();}};
      server.controlServer.on('request',accept);
    });},
  };
}

async function watch(t,runner){
  const controller=new AbortController(),snapshots=[],usage=[];
  const response=await fetch(runner.url+'/api/events',{signal:controller.signal});
  const reading=(async()=>{
    const decoder=new TextDecoder();let pending='';
    for await(const chunk of response.body){
      pending+=decoder.decode(chunk,{stream:true});let end;
      while((end=pending.indexOf('\n\n'))!==-1){
        const frame=pending.slice(0,end);pending=pending.slice(end+2);
        const type=frame.match(/^event: (.+)/)?.[1],data=frame.match(/\ndata: (.+)/)?.[1];
        if(type==='snapshot')snapshots.push(JSON.parse(data));
        if(type==='usage')usage.push(JSON.parse(data));
      }
    }
  })().catch(error=>{if(error.name!=='AbortError')throw error;});
  t.after(async()=>{controller.abort();await reading;});
  await until(()=>snapshots.length&&usage.length,'initial history and usage events');
  return {snapshots,usage};
}

test('history remains visible to reads and reconnects until deletion is durable',options,async t=>{
  const runner=await fixture(t),gate=runner.pauseNextWrite();
  const deletion=runner.request('/api/runs/target','DELETE');await gate.started;
  assert.equal((await runner.request('/api/runs/target')).status,200);
  assert.ok((await runner.request('/api/runs')).body.some(run=>run.id==='target'));
  assert.equal((await runner.request('/api/runs/target','DELETE')).status,409);
  const stream=await watch(t,runner);
  assert.ok(stream.snapshots[0].some(run=>run.id==='target'));
  assert.equal(stream.usage[0].retainedRuns,0);
  assert.ok((await runner.saved()).some(run=>run.id==='target'));
  gate.release();assert.equal((await deletion).status,200);
  await until(()=>stream.snapshots.some(snapshot=>!snapshot.some(run=>run.id==='target'))&&stream.usage.at(-1)?.retainedRuns===1,'confirmed deletion events');
  assert.equal(stream.usage.at(-1).totalTokens,15);
  assert.equal((await runner.request('/api/runs/target')).status,404);
  assert.equal((await runner.saved()).some(run=>run.id==='target'),false);
});

test('a failed history deletion cannot leak into a queued save for another repository',options,async t=>{
  const runner=await fixture(t),failure=runner.pauseNextWrite(true),following=runner.pauseNextWrite();
  const deletion=runner.request('/api/runs/target','DELETE');await failure.started;
  const received=runner.received('/api/runs/peer/archive');
  const archive=runner.request('/api/runs/peer/archive','POST');await received;
  failure.release();assert.equal((await deletion).status,400);await following.started;
  assert.equal((await runner.request('/api/runs/target')).status,200);
  following.release();assert.equal((await archive).status,202);
  const saved=await runner.saved();
  assert.ok(saved.some(run=>run.id==='target'),'a rejected deletion must remain in the durable history');
  assert.equal(saved.find(run=>run.id==='peer').archived,true);
  assert.equal((await runner.request('/api/usage')).body.retainedRuns,0);
  assert.equal((await runner.request('/api/runs/target','DELETE')).status,200);
  assert.equal((await runner.saved()).some(run=>run.id==='target'),false);
  const usage=(await runner.request('/api/usage')).body;
  assert.equal(usage.totalTokens,15);assert.equal(usage.retainedRuns,1);
});

for(const action of ['archive','unarchive'])test(`failed ${action} preserves the prior state and a retry records the action once`,options,async t=>{
  const archived=action==='unarchive',runner=await fixture(t,{archived}),gate=runner.pauseNextWrite(true);
  const before=(await runner.request('/api/runs/target')).body;
  const saving=runner.request(`/api/runs/target/${action}`,'POST');await gate.started;
  assert.equal((await runner.request('/api/runs/target')).body.archived,archived);
  gate.release();assert.equal((await saving).status,400);
  const after=(await runner.request('/api/runs/target')).body;
  assert.equal(after.archived,archived);assert.deepEqual(after.events,before.events);assert.equal(after.revision,before.revision);
  assert.equal((await runner.saved()).find(run=>run.id==='target').archived,archived);
  assert.equal((await runner.request(`/api/runs/target/${action}`,'POST')).status,202);
  const accepted=(await runner.request('/api/runs/target')).body,saved=(await runner.saved()).find(run=>run.id==='target');
  assert.equal(accepted.archived,!archived);assert.equal(saved.archived,!archived);
  assert.equal(accepted.events.filter(event=>event.type===`run.${action}`).length,1);
  assert.deepEqual(saved.events,accepted.events);
});
