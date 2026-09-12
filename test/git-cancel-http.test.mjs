import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn,execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveTool,runtimeEnvironment } from '../lib/runtime.mjs';

test('HTTP cancellation stops Git preparation before Codex starts and retains cleanup metadata', {skip:process.platform==='win32',timeout:20000}, async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'ccp-git-cancel-')),repo=path.join(dir,'repo'),data=path.join(dir,'data');
  await mkdir(repo);await mkdir(data);
  const actualGit=await resolveTool('git',undefined,{...runtimeEnvironment(),CODEX_CONTROL_PLANE_GIT_BIN:''});
  const git=(...args)=>execFileSync(actualGit,args,{cwd:repo,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'README.md'),'baseline\n');git('add','.');git('commit','-qm','Initial');
  const marker=path.join(dir,'git-ready'),codexMarker=path.join(dir,'codex-ran'),fakeGit=path.join(dir,'git'),fakeCodex=path.join(dir,'codex');
  await writeFile(fakeGit,`#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='worktree' && args[1]==='add') {
  process.on('SIGTERM',()=>{});
  require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));
  setInterval(()=>{},1000);
} else {
  const child=require('node:child_process').spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});
  process.exit(child.status ?? 1);
}
`,{mode:0o755});
  await writeFile(fakeCodex,`#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(codexMarker)},'should not run');
`,{mode:0o755});
  const child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:'0',CODEX_CONTROL_PLANE_DATA_DIR:data,CODEX_CONTROL_PLANE_GIT_BIN:fakeGit,CODEX_CONTROL_PLANE_CODEX_BIN:fakeCodex},stdio:['ignore','pipe','pipe']});
  const done=once(child,'exit');let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{child.kill('SIGTERM');await done;await rm(dir,{recursive:true,force:true});});
  const until=async check=>{for(let i=0;i<450;i++){const result=await check();if(result)return result;await delay(20);}throw new Error(`Timed out: ${output}`);};
  const url=await until(()=>output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const response=await fetch(url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repository:repo,prompt:'Cancel while preparing Git'})});
  assert.equal(response.status,202);const run=await response.json();
  const pid=await until(async()=>{try{return Number(await readFile(marker,'utf8'));}catch{return null;}});
  const recorded=JSON.parse(await readFile(path.join(data,'runs.json'),'utf8')).find(item=>item.id===run.id);
  assert.equal(recorded.baseHead,git('rev-parse','HEAD'));assert.equal(path.basename(recorded.worktree),run.id);assert.equal(recorded.branch,`codex-control-plane/${run.id}`);
  assert.equal((await fetch(url+`/api/runs/${run.id}/cancel`,{method:'POST'})).status,202);
  const cancelled=await until(async()=>{const next=await fetch(url+`/api/runs/${run.id}`).then(r=>r.json());return next.state==='cancelled' && !next.starting && next;});
  assert.equal(cancelled.worktree,null);assert.equal(cancelled.executions.length,0);
  await assert.rejects(readFile(codexMarker),error=>error.code==='ENOENT');assert.throws(()=>process.kill(pid,0));
  const health=await fetch(url+'/api/health').then(r=>r.json());assert.equal(health.gitCommands,0);assert.equal(health.activeJobs,0);
});
