import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRun } from '../lib/workflow.mjs';
import { beginExecution,appendReport,checkpointExecution } from '../lib/execution.mjs';

test('Runner startup restores interrupted reports and timing from the last saved checkpoint', {timeout:10000}, async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'ccp-recovery-'));
  const run=createRun({id:'interrupted',repository:dir,prompt:'saved task'});
  run.state='running';run.revision=20;run.runnerId='old-instance';
  const pending=createRun({id:'pending-create',repository:dir,prompt:'Unconfirmed creation'});pending.creationPending=true;
  const entry=beginExecution(run,1000);appendReport(run,entry,'重启前的部分报告');checkpointExecution(entry,7000);
  await writeFile(path.join(dir,'runs.json'),JSON.stringify([run,pending]));
  const child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:'0',CODEX_CONTROL_PLANE_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  const done=once(child,'exit');let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  t.after(async()=>{child.kill('SIGTERM');await done;await rm(dir,{recursive:true,force:true});});
  let url;
  for(let i=0;i<200;i++){url=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(url)break;await delay(20);}
  assert.ok(url,output);
  const restored=await fetch(url+'/api/runs/interrupted').then(r=>r.json());
  assert.equal(restored.state,'failed');assert.equal(restored.output,'重启前的部分报告');
  assert.equal(restored.executions[0].status,'interrupted');assert.equal(restored.usage.durationMs,6000);
  assert.notEqual(restored.runnerId,'old-instance');assert.ok(restored.revision>20);
  assert.equal(JSON.parse(await readFile(path.join(dir,'runs.json'),'utf8'))[0].executions[0].status,'interrupted');
  const unconfirmed=await fetch(url+'/api/runs/pending-create').then(r=>r.json());
  assert.equal(unconfirmed.state,'failed');assert.match(unconfirmed.error,/creation was interrupted/);assert.equal(unconfirmed.creationPending,undefined);
  assert.equal((await fetch(url+'/api/health').then(r=>r.json())).activeJobs,0);
});
