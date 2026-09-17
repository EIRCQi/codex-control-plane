import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createUsageLedger} from '../lib/usage-ledger.mjs';

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
