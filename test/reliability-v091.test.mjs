import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRun} from '../lib/workflow.mjs';
import {fixture,until} from '../test-support/runner.mjs';

const options={skip:process.platform==='win32',timeout:25000};
test('HTTP cancellation waits for resistant tool descendants before releasing the task',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());const s=await f.launch();
  const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'tree cancellation'});assert.equal(created.status,202);
  const id=created.body.id;await s.state(id,'awaiting_approval');
  assert.equal((await s.request(`/api/runs/${id}/approve`,'POST')).status,202);
  await until(async()=>{try{return JSON.parse(await readFile(f.marker,'utf8'));}catch{return null;}},'descendant ready');
  assert.equal((await s.request(`/api/runs/${id}/cancel`,'POST')).status,202);
  await s.state(id,'cancelled');
  const final=await readFile(f.marker,'utf8');await delay(150);assert.equal(await readFile(f.marker,'utf8'),final);
  const health=(await s.request('/api/health')).body;assert.equal(health.activeRuns,0);assert.equal(health.activeJobs,0);
  const retry=await s.request(`/api/runs/${id}/retry`,'POST');assert.equal(retry.status,202);
  await until(async()=>{const next=await s.run(id);return next.executions.length===3;},'retry started');
  s.child.kill('SIGTERM');await until(()=>s.closed,'shutdown after retry',10000);
  assert.equal(JSON.parse(await readFile(path.join(f.data,'runs.json'),'utf8'))[0].starting,false);
});

test('deleting history cannot refund a quota, including after restarting the Runner',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const old=createRun({id:'used-budget',repository:f.repo,prompt:'Historic use'});old.state='completed';old.usage={inputTokens:10,outputTokens:5,cachedInputTokens:0,totalTokens:15,durationMs:1,model:null};
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([old]));
  await writeFile(path.join(f.data,'settings.json'),JSON.stringify({maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:15}));
  const s=await f.launch();
  const create=runner=>runner.request('/api/runs','POST',{repository:f.repo,prompt:'Quota check',mode:'review'});
  assert.equal((await create(s)).status,400);
  assert.equal((await s.request('/api/runs/used-budget','DELETE')).status,200);
  const summary=(await s.request('/api/usage')).body;assert.equal(summary.totalTokens,15);assert.equal(summary.retainedRuns,1);
  assert.equal((await create(s)).status,400);
  await f.stop(s);const restarted=await f.launch();
  assert.equal((await create(restarted)).status,400);assert.equal((await restarted.request('/api/usage')).body.totalTokens,15);
  assert.equal((await restarted.request('/api/runs')).body.length,0);
});

test('a repository usage event stops other running tasks in the same repository',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  await writeFile(path.join(f.data,'settings.json'),JSON.stringify({maxConcurrentRuns:2,maxTokensPerRun:0,maxTokensPerRepository:15}));
  const s=await f.launch();
  const peer=await s.request('/api/runs','POST',{repository:f.repo,prompt:'quota peer',mode:'review'});assert.equal(peer.status,202);
  await until(async()=>(await s.run(peer.body.id)).logs.some(log=>log.message==='peer ready'),'peer running');
  const reporter=await s.request('/api/runs','POST',{repository:f.repo,prompt:'quota reporter',mode:'review'});assert.equal(reporter.status,202);
  await s.state(reporter.body.id,'budget_exceeded');await s.state(peer.body.id,'budget_exceeded');
  const health=(await s.request('/api/health')).body;assert.equal(health.activeJobs,0);assert.equal(health.activeRuns,0);
});

test('an approved apply survives a failed history save and restart without reapplying the patch',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const file=path.join(f.data,'runs.json'),journal=path.join(f.data,'apply-journal.json');
  const s=await f.launch();const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Apply failure'});assert.equal(created.status,202);
  const id=created.body.id;await s.state(id,'awaiting_approval');await s.request(`/api/runs/${id}/approve`,'POST');await s.state(id,'awaiting_merge');
  // If the approval intent cannot be saved, no source files are changed.
  await mkdir(journal);
  assert.equal((await s.request(`/api/runs/${id}/apply`,'POST')).status,400);
  assert.equal(await readFile(path.join(f.repo,'README.md'),'utf8'),'baseline\n');
  await rm(journal,{recursive:true,force:true});
  await rename(file,file+'.saved');await mkdir(file);
  try {
    const response=await s.request(`/api/runs/${id}/apply`,'POST');assert.equal(response.status,400);assert.match(response.body.error,/outcome needs verification/);
    assert.equal(await readFile(path.join(f.repo,'README.md'),'utf8'),'approved change\n');
    assert.equal((await s.run(id)).applyRecovery,true);
    assert.equal(JSON.parse(await readFile(file+'.saved','utf8')).find(r=>r.id===id).state,'awaiting_merge');
    assert.equal(JSON.parse(await readFile(journal,'utf8')).length,1);
    await f.stop(s,'SIGKILL');
  }finally{await rm(file,{recursive:true,force:true});await rename(file+'.saved',file);}
  const restarted=await f.launch();const recovered=await restarted.run(id);
  assert.equal(recovered.state,'completed');assert.equal(recovered.applyRecovery,undefined);assert.equal(recovered.worktree,null);
  assert.equal(await readFile(path.join(f.repo,'README.md'),'utf8'),'approved change\n');
  assert.deepEqual(JSON.parse(await readFile(journal,'utf8')),[]);
  assert.equal((await restarted.request(`/api/runs/${id}/apply`,'POST')).status,400);
});

test('uncertain recovery preserves extra edits and blocks discard until explicitly reconciled',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());const file=path.join(f.data,'runs.json');
  const s=await f.launch();const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Uncertain apply'});const id=created.body.id;
  await s.state(id,'awaiting_approval');await s.request(`/api/runs/${id}/approve`,'POST');await s.state(id,'awaiting_merge');
  await rename(file,file+'.saved');await mkdir(file);
  try {await s.request(`/api/runs/${id}/apply`,'POST');await f.stop(s,'SIGKILL');}
  finally{await rm(file,{recursive:true,force:true});await rename(file+'.saved',file);}
  await writeFile(path.join(f.repo,'README.md'),'manual change after interruption\n');
  const restarted=await f.launch();
  const uncertain=await restarted.run(id);assert.equal(uncertain.state,'awaiting_merge');assert.equal(uncertain.applyRecovery,true);
  assert.equal((await restarted.request(`/api/runs/${id}/discard`,'POST')).status,400);
  assert.equal((await restarted.request(`/api/runs/${id}/apply`,'POST')).status,400);
  assert.equal((await restarted.request(`/api/runs/${id}/reconcile`,'POST')).status,400);
  assert.equal(await readFile(path.join(f.repo,'README.md'),'utf8'),'manual change after interruption\n');
  // Explicit test-fixture resolution restores the approved result; recovery itself never does this.
  await writeFile(path.join(f.repo,'README.md'),'approved change\n');
  assert.equal((await restarted.request(`/api/runs/${id}/reconcile`,'POST')).status,202);
  assert.equal((await restarted.run(id)).state,'completed');
});

test('a second port cannot write the same data directory; normal exit and crash release ownership',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());const a=await f.launch();
  const first=await a.request('/api/templates','POST',{name:'Saved template',prompt:'A {{task}}'});assert.equal(first.status,201);
  const before=await readFile(path.join(f.data,'templates.json'),'utf8');
  const rejected=await f.launch({expectFailure:true});assert.equal((await rejected.done).code,1);assert.match(rejected.output,/数据目录/);
  assert.equal(await readFile(path.join(f.data,'templates.json'),'utf8'),before);
  await f.stop(a);const next=await f.launch();assert.ok((await next.request('/api/templates')).body.some(item=>item.id===first.body.id));
  await f.stop(next,'SIGKILL');const afterCrash=await f.launch();
  assert.ok((await afterCrash.request('/api/templates')).body.some(item=>item.id===first.body.id));
});
