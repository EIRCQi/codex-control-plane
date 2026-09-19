import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUsageLedger} from '../lib/usage-ledger.mjs';
import {saveJson} from '../lib/storage.mjs';
import {emptyUsage,aggregateUsage} from '../lib/usage.mjs';
import {beginExecution,checkpointExecution,recoverExecutions} from '../lib/execution.mjs';

test('ledger migration and repeated recovery never double count or refund deleted usage',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'usage.json');
  const run={id:'run',repository:'/repo',usage:{inputTokens:10,outputTokens:5,totalTokens:15,durationMs:20}};
  const ledger=await createUsageLedger(file);ledger.observe(run);ledger.observe(run);await ledger.flush();
  assert.equal(ledger.repositoryTokens('/repo'),15);assert.equal(ledger.summary([]).retainedRuns,1);
  const restored=await createUsageLedger(file);restored.observe(run);restored.observe({...run,usage:{totalTokens:1}});
  assert.equal(restored.repositoryTokens('/repo'),15);
  restored.observe({...run,usage:{totalTokens:30,durationMs:40}});await restored.flush();
  assert.equal((await createUsageLedger(file)).summary([]).totalTokens,30);
});

test('a failed ledger save rejects without losing observed usage; a later save recovers',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-ledger-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'usage.json');
  const ledger=await createUsageLedger(file);await ledger.flush();await rename(file,file+'.saved');await mkdir(file);
  ledger.observe({id:'run',repository:'/repo',usage:{totalTokens:100}});
  await assert.rejects(ledger.flush());assert.equal(ledger.repositoryTokens('/repo'),100);
  await rm(file,{recursive:true,force:true});await rename(file+'.saved',file);await ledger.flush();
  assert.equal((await createUsageLedger(file)).repositoryTokens('/repo'),100);
});

test('unchanged checkpoints do not rewrite a thousand-entry ledger',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-ledger-skip-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'usage.json');
  let writes=0;
  const ledger=await createUsageLedger(file,{write:(file,value)=>{writes++;return saveJson(file,value);}});
  const runs=Array.from({length:1000},(_,i)=>({id:String(i),repository:'/repo',usage:{...emptyUsage(),inputTokens:i,totalTokens:i}}));
  ledger.observeAll(runs);await ledger.flush();assert.equal(writes,1);
  for(let i=0;i<200;i++){ledger.observe(runs[i]);await ledger.flush();}
  assert.equal(writes,1);assert.equal(ledger.summary(runs).totalTokens,499500);
  assert.equal(ledger.summary(runs.slice(0,500)).retainedRuns,500);
});

test('new observations during an active save wait for a covering durable snapshot',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-ledger-pending-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'usage.json');
  let release,entered,attempt=0;
  const blocked=new Promise(resolve=>{entered=resolve;});
  const ledger=await createUsageLedger(file,{write:async(file,value)=>{
    if(++attempt===1){entered();await new Promise(resolve=>{release=resolve;});}
    await saveJson(file,value);
  }});
  ledger.observe({id:'run',repository:'/repo',usage:{totalTokens:10}});
  const first=ledger.flush();await blocked;
  ledger.observe({id:'run',repository:'/repo',usage:{totalTokens:25}});
  let acknowledged=false;const later=ledger.flush().then(()=>{acknowledged=true;});
  await Promise.resolve();assert.equal(acknowledged,false);release();await Promise.all([first,later]);
  assert.equal(JSON.parse(await readFile(file,'utf8')).entries[0].usage.totalTokens,25);assert.equal(attempt,2);
  await ledger.flush();assert.equal(attempt,2);
});

test('cached totals and restored execution time remain correct after model changes and repeated restart',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-ledger-totals-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'usage.json');
  const a={id:'a',repository:'/repo',executionSeq:0,usage:{...emptyUsage(),inputTokens:40,outputTokens:20,totalTokens:60,durationMs:20,model:'old'}};
  const b={id:'b',repository:'/other',usage:{...emptyUsage(),inputTokens:5,totalTokens:5,model:'other'}};
  const ledger=await createUsageLedger(file);ledger.observeAll([a,b]);await ledger.flush();
  const stale={...a,usage:{...emptyUsage(),inputTokens:10,totalTokens:10}};
  const execution=beginExecution(stale,1000);checkpointExecution(execution,1015);recoverExecutions(stale);
  assert.equal(stale.usage.durationMs,15);assert.equal(ledger.restore(stale),true);assert.equal(stale.usage.durationMs,20);assert.equal(stale.usage.totalTokens,60);
  assert.equal(ledger.restore(stale),false);
  stale.usage={...stale.usage,totalTokens:75,inputTokens:55,model:'new'};ledger.observe(stale);await ledger.flush();
  const expected=aggregateUsage([stale,b]),actual=ledger.summary([stale,b]);
  for(const key of ['inputTokens','outputTokens','totalTokens','durationMs','models','runs'])assert.deepEqual(actual[key],expected[key]);
  actual.models.new=0;assert.equal(ledger.summary([]).models.new,75);
  const restored=await createUsageLedger(file);recoverExecutions(stale);assert.equal(restored.restore(stale),false);
  assert.equal(restored.summary([]).durationMs,20);assert.equal(restored.repositoryTokens('/repo'),75);
  const outdatedModel={...stale,usage:{...stale.usage,model:'old'}};
  assert.equal(restored.restore(outdatedModel),true);assert.equal(outdatedModel.usage.model,'new');assert.equal(outdatedModel.usage.totalTokens,75);
});
