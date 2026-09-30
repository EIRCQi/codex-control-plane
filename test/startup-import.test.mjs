import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('an imported Runner can be stopped before its initial save finishes', {timeout:10000}, async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ccp-startup-import-'));
  const entered=deferred(),released=deferred(),originalRename=fs.rename;
  const environment={PORT:process.env.PORT,CODEX_CONTROL_PLANE_DATA_DIR:process.env.CODEX_CONTROL_PLANE_DATA_DIR};
  const listeners=new Map(['SIGINT','SIGTERM'].map(signal=>[signal,new Set(process.listeners(signal))]));
  let importing;
  t.after(async()=>{
    released.resolve();fs.rename=originalRename;syncBuiltinESMExports();
    try {await (await importing)?.shutdown();}
    finally {
      for(const [key,value] of Object.entries(environment))if(value===undefined)delete process.env[key];else process.env[key]=value;
      for(const [signal,previous] of listeners)for(const listener of process.listeners(signal))if(!previous.has(listener))process.removeListener(signal,listener);
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
  fs.rename=async(source,destination)=>{
    if(destination===path.join(directory,'runs.json')){entered.resolve();await released.promise;}
    return originalRename(source,destination);
  };
  syncBuiltinESMExports();
  process.env.PORT='0';process.env.CODEX_CONTROL_PLANE_DATA_DIR=directory;
  importing=import(`../server.mjs?startup-import=${randomUUID()}`);
  assert.equal(await Promise.race([importing.then(()=>true),entered.promise.then(()=>false)]),true,'shutdown must be exported before startup waits for disk');
  const runner=await importing;await entered.promise;
  assert.equal(runner.controlServer.listening,true);
  const stopping=runner.shutdown();
  assert.equal(runner.shutdown(),stopping);
  released.resolve();
  await assert.rejects(runner.serverReady,/Runner is stopping/);
  await stopping;
  assert.equal(runner.controlServer.listening,false);
  await assert.rejects(fs.access(path.join(directory,'runner.lock')),{code:'ENOENT'});
});
