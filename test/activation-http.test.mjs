import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename,mkdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fixture,until} from '../test-support/runner.mjs';
import {approveRun,createRun,prepareRetry,stageActivation} from '../lib/workflow.mjs';

const options={skip:process.platform==='win32',timeout:20000};
async function blockHistory(f,work){
  const file=path.join(f.data,'runs.json');
  await rename(file,file+'.saved');await mkdir(file);
  try{return await work();}
  finally{await rm(file,{recursive:true,force:true});await rename(file+'.saved',file);}
}

test('a failed retry save does not become runnable when another task releases a slot',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const old=createRun({id:'failed-retry',repository:f.repo,prompt:'Must wait for an accepted retry',mode:'review'});old.state='failed';
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([old]));
  await writeFile(path.join(f.data,'settings.json'),JSON.stringify({maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:0}));
  const s=await f.launch();
  const peer=await s.request('/api/runs','POST',{repository:f.repo,prompt:'quota peer',mode:'review'});
  await until(async()=>(await s.run(peer.body.id)).logs.some(log=>log.message==='peer ready'),'peer occupies slot');
  await blockHistory(f,async()=>assert.equal((await s.request(`/api/runs/${old.id}/retry`,'POST')).status,400));
  await s.request(`/api/runs/${peer.body.id}/cancel`,'POST');await s.state(peer.body.id,'cancelled');
  await until(async()=>(await s.request('/api/health')).body.activeJobs===0,'queue drained');
  const after=await s.run(old.id);
  assert.equal(after.state,'failed');assert.equal(after.retries,0);assert.equal(after.executions.length,0);
  assert.equal((await s.request(`/api/runs/${old.id}/retry`,'POST')).status,202);
  assert.equal((await s.state(old.id,'completed')).retries,1);
});

test('a failed approval save leaves the task waiting for approval',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());const s=await f.launch();
  const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Approve after saving'});const id=created.body.id;
  const before=await s.state(id,'awaiting_approval');
  await blockHistory(f,async()=>assert.equal((await s.request(`/api/runs/${id}/approve`,'POST')).status,400));
  await until(async()=>(await s.request('/api/health')).body.activeJobs===0,'approval settled');
  const after=await s.run(id);
  assert.equal(after.state,'awaiting_approval');assert.equal(after.executions.length,before.executions.length);
  assert.equal(after.events.some(event=>event.type==='run.approved'),false);
  assert.equal((await s.request(`/api/runs/${id}/approve`,'POST')).status,202);
  await s.state(id,'awaiting_merge');
});

test('implementation retry removes ignored leftovers from the previous attempt',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  await writeFile(path.join(f.repo,'.gitignore'),'stale-cache/\n');f.git('add','.');f.git('commit','-qm','Ignore test cache');
  const marker=path.join(f.dir,'first-attempt');
  await writeFile(path.join(f.dir,'codex'),`#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('workspace-write')){
  if(!fs.existsSync(${JSON.stringify(marker)})){
    fs.mkdirSync('stale-cache');fs.writeFileSync('stale-cache/config.json','stale');fs.writeFileSync(${JSON.stringify(marker)},'attempted');process.exit(1);
  }
  if(fs.existsSync('stale-cache/config.json')){console.error('Ignored data survived retry');process.exit(2);}
}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Clean retry'}}));
`,{mode:0o755});
  const s=await f.launch();const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Clean retry'});const id=created.body.id;
  await s.state(id,'awaiting_approval');await s.request(`/api/runs/${id}/approve`,'POST');
  const failed=await s.state(id,'failed');assert.equal(await readFile(path.join(failed.worktree,'stale-cache/config.json'),'utf8'),'stale');
  assert.equal((await s.request(`/api/runs/${id}/retry`,'POST')).status,202);
  const after=await until(async()=>{const r=await s.run(id);return !r.starting&&r.executions.length===3&&r;},'retry finished');
  assert.equal(after.state,'completed');assert.equal(after.executions.at(-1).exitCode,0);
  assert.equal(f.git('status','--porcelain'),'');
});

test('startup restores pending decisions without scheduling them or keeping an unconfirmed approval',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const approval=createRun({id:'pending-approval',repository:f.repo,prompt:'Unconfirmed approval'});approval.state='awaiting_approval';approval.phase='implementation';
  stageActivation(approval,next=>{approveRun(next);next.queuedAction='implementation';});
  const retry=createRun({id:'pending-retry',repository:f.repo,prompt:'Unconfirmed retry'});retry.state='failed';retry.error='Prior failure';
  stageActivation(retry,next=>{prepareRetry(next);next.queuedAction='analysis';});
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([approval,retry]));
  const s=await f.launch();
  const restored=await s.run(approval.id),failed=await s.run(retry.id);
  assert.equal(restored.state,'awaiting_approval');assert.equal(restored.events.some(e=>e.type==='run.approved'),false);
  assert.equal(failed.state,'failed');assert.equal(failed.retries,0);assert.equal(failed.error,'Prior failure');
  assert.equal((await s.request('/api/health')).body.activeJobs,0);
  const saved=JSON.parse(await readFile(path.join(f.data,'runs.json'),'utf8'));
  assert.ok(saved.every(run=>!run.activationPending&&run.executions.length===0));
  await f.stop(s);const restarted=await f.launch();
  assert.equal((await restarted.run(approval.id)).events.filter(e=>e.type==='run.activation_recovered').length,1);
});

test('a confirmed approval queued behind another task survives an orderly restart',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  await writeFile(path.join(f.data,'settings.json'),JSON.stringify({maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:0}));
  const s=await f.launch();const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Queued approval'});const id=created.body.id;
  await s.state(id,'awaiting_approval');
  const peer=await s.request('/api/runs','POST',{repository:f.repo,prompt:'quota peer',mode:'review'});
  await until(async()=>(await s.run(peer.body.id)).logs.some(log=>log.message==='peer ready'),'peer occupies slot');
  const approved=await s.request(`/api/runs/${id}/approve`,'POST');
  assert.equal(approved.status,202);assert.equal(approved.body.state,'approved');assert.equal(approved.body.activationPending,undefined);
  await f.stop(s);
  const saved=JSON.parse(await readFile(path.join(f.data,'runs.json'),'utf8')).find(run=>run.id===id);
  assert.equal(saved.state,'approved');assert.equal(saved.activationPending,undefined);
  const restarted=await f.launch();const implemented=await restarted.state(id,'awaiting_merge');
  assert.equal(implemented.executions.length,2);assert.equal(implemented.events.filter(e=>e.type==='run.approved').length,1);
});

test('retry refuses a redirected worktree before removing ignored files outside its owned path',options,async t=>{
  const f=await fixture();
  const id='redirected-'+path.basename(f.dir),owned=path.join(os.tmpdir(),'codex-control-plane-worktrees',id);
  t.after(async()=>{await rm(owned,{force:true});await f.cleanup();});
  await writeFile(path.join(f.repo,'.gitignore'),'keep-private.txt\n');f.git('add','.');f.git('commit','-qm','Ignored local file');
  const outside=path.join(f.dir,'outside');f.git('worktree','add','--detach',outside,'HEAD');
  await writeFile(path.join(outside,'keep-private.txt'),'preserve this file');
  await mkdir(path.dirname(owned),{recursive:true});await symlink(outside,owned);
  const run=createRun({id,repository:f.repo,prompt:'Bad path'});run.state='failed';run.phase='implementation';run.events.push({type:'run.approved'});
  run.baseHead=f.git('rev-parse','HEAD');run.baseRef=f.git('symbolic-ref','HEAD');run.worktree=owned;
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([run]));
  const s=await f.launch();const response=await s.request(`/api/runs/${id}/retry`,'POST');
  assert.equal(response.status,400);assert.match(response.body.error,/does not belong to this task/);
  assert.equal(await readFile(path.join(outside,'keep-private.txt'),'utf8'),'preserve this file');
  assert.equal((await s.run(id)).retries,0);
});
