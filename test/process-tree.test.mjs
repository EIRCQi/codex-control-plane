import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {manageProcessTree,ownedProcessOptions} from '../lib/process-tree.mjs';

test('normal managed exit drains all final output',async()=>{
  const child=spawn(process.execPath,['-e',"process.stdout.write('x'.repeat(1024*1024))"],{...ownedProcessOptions,stdio:['ignore','pipe','pipe']});
  const scope=manageProcessTree(child);let bytes=0;child.stdout.on('data',chunk=>bytes+=chunk.length);
  const result=await scope.wait();assert.equal(result.code,0);assert.equal(bytes,1024*1024);
});

for(const stdio of ['inherit','ignore'])test(`cancellation stops resistant descendants with ${stdio} stdio`,{timeout:10000},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-process-tree-')),marker=path.join(dir,'ticks'),worker=path.join(dir,'worker.cjs');
  await writeFile(worker,`const fs=require('node:fs');let n=0;process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(++n)),20);setTimeout(()=>process.exit(0),8000);`);
  const child=spawn(process.execPath,['-e',`require('node:child_process').spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:${JSON.stringify(stdio)}});setInterval(()=>{},1000);`],{...ownedProcessOptions,stdio:['ignore','pipe','pipe']});
  const scope=manageProcessTree(child,{graceMs:80});child.on('error',()=>{});
  t.after(async()=>{await scope.stop();await scope.wait();await rm(dir,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{await readFile(marker);ready=true;break;}catch{}await delay(20);}assert.ok(ready);
  await scope.stop();await scope.wait();await delay(40);
  const stopped=await readFile(marker,'utf8');await delay(120);assert.equal(await readFile(marker,'utf8'),stopped);
});
