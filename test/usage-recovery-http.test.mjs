import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,until} from '../test-support/runner.mjs';
import {createRun} from '../lib/workflow.mjs';
import {createUsageLedger} from '../lib/usage-ledger.mjs';
import {createApplyJournal} from '../lib/apply-journal.mjs';

const options={skip:process.platform==='win32',timeout:20000};
test('ledger-ahead crash recovery restores task usage before retry budget checks',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const run=createRun({id:'interrupted-budget',repository:f.repo,prompt:'Review',mode:'review'});run.state='failed';run.usage.inputTokens=10;run.usage.outputTokens=5;run.usage.totalTokens=15;
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([run]));
  await writeFile(path.join(f.data,'settings.json'),JSON.stringify({maxConcurrentRuns:1,maxTokensPerRun:50,maxTokensPerRepository:0}));
  const ledger=await createUsageLedger(path.join(f.data,'usage-ledger.json'));
  ledger.observe({...run,usage:{inputTokens:40,outputTokens:20,cachedInputTokens:10,totalTokens:60,durationMs:125,model:'fixture-model'}});await ledger.flush();
  const s=await f.launch();const restored=await s.run(run.id);
  assert.equal(restored.usage.totalTokens,60);assert.equal(restored.usage.durationMs,125);assert.equal(restored.usage.model,'fixture-model');
  const denied=await s.request(`/api/runs/${run.id}/retry`,'POST');assert.equal(denied.status,400);assert.match(denied.body.error,/Run token budget exceeded/);
  assert.equal((await s.run(run.id)).executions.length,0);
  await f.stop(s);const next=await f.launch();
  assert.equal((await next.run(run.id)).usage.totalTokens,60);assert.equal((await next.request('/api/usage')).body.totalTokens,60);
});

test('a log burst does not resend unchanged usage for a thousand historical tasks',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const history=Array.from({length:1000},(_,i)=>{const run=createRun({id:`history-${i}`,repository:f.repo,prompt:'Historical task'});run.state='completed';return run;});
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify(history));
  const trigger=path.join(f.dir,'start-logs');
  await writeFile(path.join(f.dir,'codex'),`#!${process.execPath}
const fs=require('node:fs');
console.log(JSON.stringify({type:'output',message:'ready for logs'}));
let n=0;const timer=setInterval(()=>{
  if(!fs.existsSync(${JSON.stringify(trigger)}))return;
  console.log(JSON.stringify({type:'output',message:'log '+(++n)}));
  if(n===80){clearInterval(timer);console.log(JSON.stringify({type:'output',message:'logs complete'}));}
},8);setInterval(()=>{},1000);
`,{mode:0o755});
  const s=await f.launch();const created=await s.request('/api/runs','POST',{repository:f.repo,prompt:'Log burst',mode:'review'});assert.equal(created.status,202);
  await until(async()=>(await s.run(created.body.id)).logs.some(log=>log.message==='ready for logs'),'ready');
  const controller=new AbortController();let usageFrames=0,runFrames=0,pending='';
  const response=await fetch(s.url+'/api/events',{signal:controller.signal});
  const reading=(async()=>{for await(const chunk of response.body){pending+=Buffer.from(chunk).toString();let end;while((end=pending.indexOf('\n\n'))!==-1){const frame=pending.slice(0,end);pending=pending.slice(end+2);if(frame.startsWith('event: usage\n'))usageFrames++;if(frame.startsWith('event: run\n'))runFrames++;}}})().catch(error=>{if(error.name!=='AbortError')throw error;});
  try {
    await until(()=>usageFrames>0,'initial usage');await delay(200);const before=usageFrames;runFrames=0;
    await writeFile(trigger,'go');
    await until(async()=>(await s.run(created.body.id)).logs.some(log=>log.message==='logs complete'),'all logs delivered');await delay(150);
    assert.ok(runFrames>=3,'logs must continue to update the task');
    assert.equal(usageFrames,before,'unchanged cumulative usage must not be broadcast for ordinary logs');
  }finally{controller.abort();await reading;}
});

test('shutdown aborts Git recovery during startup without waiting for the Git deadline',options,async t=>{
  const f=await fixture();t.after(()=>f.cleanup());
  const run=createRun({id:'pending-apply',repository:f.repo,prompt:'Interrupted apply'});run.state='awaiting_merge';run.phase='review';run.baseHead=f.git('rev-parse','HEAD');run.baseRef=f.git('symbolic-ref','HEAD');
  await writeFile(path.join(f.data,'runs.json'),JSON.stringify([run]));
  const journal=await createApplyJournal(path.join(f.data,'apply-journal.json'));await journal.prepare(run,f.git('rev-parse','HEAD^{tree}'));
  const marker=path.join(f.dir,'git-started'),fakeGit=path.join(f.dir,'git');
  await writeFile(fakeGit,`#!${process.execPath}
process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000);
`,{mode:0o755});
  let gitPid;
  t.after(()=>{if(gitPid)try{process.kill(-gitPid,'SIGKILL');}catch{}});
  const s=await f.launch({waitReady:false,env:{CODEX_CONTROL_PLANE_GIT_BIN:fakeGit,CODEX_CONTROL_PLANE_GIT_TIMEOUT_MS:'30000'}});
  gitPid=await until(async()=>{try{return Number(await readFile(marker,'utf8'));}catch{return null;}},'recovery Git started');
  s.child.kill('SIGTERM');await until(()=>s.closed,'startup shutdown',5000);
  assert.equal((await s.done).code,0);
  await assert.rejects(readFile(path.join(f.data,'runner.lock')),error=>error.code==='ENOENT');
  assert.equal(JSON.parse(await readFile(path.join(f.data,'apply-journal.json'),'utf8')).length,1);
});
