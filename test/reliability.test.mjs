import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRun } from '../lib/workflow.mjs';
import { saveJson, loadJson } from '../lib/storage.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
test('concurrent saves preserve the latest complete snapshot; corrupt data is not discarded', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccp-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runs.json');
  await Promise.all(Array.from({ length: 60 }, (_, i) => saveJson(file, { i, payload: 'x'.repeat(2000) })));
  assert.equal((await loadJson(file, {})).i, 59);
  await writeFile(file, '{broken');
  await assert.rejects(loadJson(file, []), /Original file preserved/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

// No paid Codex calls: a local executable simulates the CLI protocol and cancellation.
test('real HTTP/worktree lifecycle, rejection retry, duplicate apply, and cancellation', { skip: process.platform === 'win32', timeout: 45000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccp-integration-'));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  await mkdir(repo); await mkdir(bin);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(path.join(repo, 'README.md'), 'baseline\n');
  git('add', '.'); git('commit', '-qm', 'Initial');
  const originalHead = git('rev-parse', 'HEAD');
  await writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv;
if (args.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }
if (args.includes('login')) { console.log('credential-marker-private'); process.exit(0); }
if (args.at(-1).includes('gated quota')) {
  console.log(JSON.stringify({type:'output', message:'ready'}));
  const timer=setInterval(() => {
    if (fs.existsSync(${JSON.stringify(path.join(dir,'release-quota'))})) {
      clearInterval(timer);
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
    }
  }, 20);
} else if (args.at(-1).includes('slow')) {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({type:'output', message:'ready'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'运行中的部分报告'}}));
  console.error('running diagnostic');
  setInterval(() => {}, 1000);
} else {
  if (args.includes('workspace-write')) fs.writeFileSync('README.md', 'approved change\\n');
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'Review report: README.md checked.'}}));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:10, output_tokens:5}}));
}
`, { mode: 0o755 });
  const data = path.join(dir, 'data');
  await mkdir(data);
  const legacy = createRun({id:'legacy-run', repository:repo, prompt:'Previous version task'});
  legacy.state = 'completed'; delete legacy.mode;
  await writeFile(path.join(data, 'runs.json'), JSON.stringify([legacy]));
  const env = { ...process.env, CODEX_CONTROL_PLANE_GIT_BIN:'', CODEX_CONTROL_PLANE_CODEX_BIN:'', PORT: '0', CODEX_CONTROL_PLANE_DATA_DIR: data, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (c) => output += c); child.stderr.on('data', (c) => output += c);
  const done = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await done; await rm(dir, { recursive: true, force: true }); });
  const until = async (predicate) => { for (let i = 0; i < 600; i++) { const result = await predicate(); if (result) return result; await delay(20); } throw new Error(`Timed out: ${output}`); };
  const url = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const request = (route, method = 'GET', body) => fetch(url + route, { method, headers: { 'content-type':'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const run = (id) => request(`/api/runs/${id}`).then((r) => r.json());
  const state = (id, target) => until(async () => { const r = await run(id); return r.state === target && !r.starting && r; });
  const start = async (prompt, extra = {}) => { const r = await request('/api/runs', 'POST', {repository:repo, prompt, ...extra}); assert.equal(r.status, 202); return r.json(); };
  const action = (id, op) => request(`/api/runs/${id}/${op}`, 'POST');

  // Invalid or failed settings writes cannot change the live policy.
  const initialSettings = await request('/api/settings').then(r=>r.json());
  assert.equal((await request('/api/settings', 'PUT', {...initialSettings,maxTokensPerRun:null})).status,400);
  assert.deepEqual(await request('/api/settings').then(r=>r.json()),initialSettings);
  const eventsAbort=new AbortController();
  t.after(()=>eventsAbort.abort());
  const eventResponse=await fetch(url+'/api/events',{signal:eventsAbort.signal});
  let streamed='';
  const eventRead=(async()=>{for await(const chunk of eventResponse.body) streamed+=Buffer.from(chunk).toString();})().catch(error=>{if(error.name!=='AbortError')throw error;});
  try {
    assert.equal((await request('/api/settings', 'PUT', initialSettings)).status,200);
    assert.equal((await request('/api/projects','POST',{name:'Test project',repository:repo})).status,201);
    await until(()=>streamed.includes('event: settings\n') && streamed.includes('event: catalog\n'));
    assert.match(streamed,/Test project/);
  } finally { eventsAbort.abort();await eventRead; }
  const settingsPath=path.join(data,'settings.json');
  await rename(settingsPath,settingsPath+'.saved');await mkdir(settingsPath);
  try {
    assert.equal((await request('/api/settings','PUT',{...initialSettings,maxConcurrentRuns:8})).status,400);
    assert.deepEqual(await request('/api/settings').then(r=>r.json()),initialSettings);
  } finally { await rm(settingsPath,{recursive:true,force:true});await rename(settingsPath+'.saved',settingsPath); }

  const emptyRepo=path.join(dir,'empty');await mkdir(emptyRepo);execFileSync('git',['init','-q'],{cwd:emptyRepo});
  const emptyResult=await request('/api/runs','POST',{repository:emptyRepo,prompt:'No commit yet'});
  assert.equal(emptyResult.status,400);assert.match((await emptyResult.json()).error,/initial Git commit/);

  const foreign = await fetch(url+'/api/runs', {method:'POST',headers:{'content-type':'application/json',origin:'https://example.invalid'},body:JSON.stringify({repository:repo,prompt:'Foreign request'})});
  assert.equal(foreign.status, 403);
  const historical = await request('/api/runs').then(r=>r.json());
  assert.equal(historical.length, 1); assert.equal(historical[0].mode, 'implement');
  const health = await request('/api/health').then(r=>r.json());
  assert.equal(health.version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  const diagnostics = await request('/api/diagnostics').then(r=>r.json());
  assert.equal(diagnostics.ready, true); assert.equal(diagnostics.codex.version, '1.2.3');
  assert.doesNotMatch(JSON.stringify(diagnostics), /credential-marker/);
  assert.equal((await request('/api/runtime', 'PUT', {codexPath:'relative'})).status, 400);
  assert.equal((await request('/api/runtime', 'PUT', {codexPath:path.join(bin,'missing')})).status, 400);
  const configured = {gitPath:'', codexPath:path.join(bin,'codex')};
  assert.equal((await request('/api/runtime', 'PUT', configured)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(data,'runtime.json'), 'utf8')), configured);
  assert.equal((await request('/api/runtime').then(r=>r.json())).codexPath, configured.codexPath);

  // Missing executables fail before a run or worktree is created.
  await rename(configured.codexPath, configured.codexPath + '.offline');
  try {
    const unavailable = await request('/api/runs', 'POST', {repository:repo, prompt:'Missing CLI'});
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /Cannot execute codex/);
    assert.equal((await request('/api/runs').then(r=>r.json())).length, 1);
    assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { await rename(configured.codexPath + '.offline', configured.codexPath); }

  const review = await start('Review repository', {mode:'implement', templateId:'builtin-review'});
  const reviewed = await state(review.id, 'completed');
  assert.equal(reviewed.task,'Review repository');
  assert.match(reviewed.templatePrompt,/\{\{task\}\}/);
  assert.equal(reviewed.mode, 'review'); assert.equal(reviewed.worktree, null);
  assert.ok(reviewed.events.every((event) => !/approval|approved|merge/.test(event.type)));
  assert.match(reviewed.output, /Review report/);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.equal((await action(review.id, 'approve')).status, 400);
  assert.equal((await action(review.id, 'apply')).status, 400);
  const first = await start('Improve README');
  await state(first.id, 'awaiting_approval');
  assert.equal((await request('/api/runtime', 'PUT', configured)).status, 400);
  assert.equal((await action(first.id, 'apply')).status, 400);
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'baseline\n');
  await action(first.id, 'reject');
  await action(first.id, 'retry');
  await state(first.id, 'awaiting_approval');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'baseline\n');
  const beforeApproval=await run(first.id);
  await request('/api/settings','PUT',{...initialSettings,maxTokensPerRun:beforeApproval.usage.totalTokens});
  assert.equal((await action(first.id,'approve')).status,400);
  assert.equal((await run(first.id)).state,'awaiting_approval');
  await request('/api/settings','PUT',initialSettings);
  await action(first.id, 'approve');
  await state(first.id, 'awaiting_merge');
  const results = await Promise.all([action(first.id, 'apply'), action(first.id, 'apply')]);
  assert.equal(results.filter((r) => r.status === 202).length, 1);
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'approved change\n');
  assert.equal((await action(first.id, 'apply')).status, 400);
  git('reset', '--hard', originalHead);

  const changed = await start('Change again');
  await state(changed.id, 'awaiting_approval'); await action(changed.id, 'approve'); await state(changed.id, 'awaiting_merge');
  git('checkout', '-qb', 'other-branch');
  const mismatch = await action(changed.id, 'apply');
  assert.equal(mismatch.status, 400); assert.match((await mismatch.json()).error, /HEAD or branch changed/);
  await action(changed.id, 'discard');

  const slow = await start('slow analysis');
  await until(async () => (await run(slow.id)).logs?.some((log) => log.message === 'ready'));
  await until(async () => {
    const saved=JSON.parse(await readFile(path.join(data,'runs.json'),'utf8')).find(entry=>entry.id===slow.id);
    return saved?.executions?.at(-1)?.durationMs>0 && saved.output.includes('运行中的部分报告');
  });
  await action(slow.id, 'cancel');
  assert.equal((await action(slow.id, 'retry')).status, 400);
  assert.equal((await request(`/api/runs/${slow.id}`, 'DELETE')).status, 400);
  const cancelled=await state(slow.id, 'cancelled'); // resistant CLI must be killed within the grace period
  assert.match(cancelled.executions.at(-1).output,/运行中的部分报告/);
  assert.equal(cancelled.executions.at(-1).status,'cancelled');
  assert.match(cancelled.executions.at(-1).diagnostics,/running diagnostic/);
  assert.equal((await request(`/api/runs/${slow.id}`, 'DELETE')).status, 200);

  // Budget termination has the same escalation path as user cancellation.
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:1, maxTokensPerRepository:0});
  const budget = await start('Small budget');
  const stoppedBudget=await state(budget.id, 'budget_exceeded');
  assert.equal((await action(budget.id,'retry')).status,400);
  assert.equal((await run(budget.id)).executionSeq,stoppedBudget.executionSeq);
  assert.equal((await run(budget.id)).retries,stoppedBudget.retries);
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:0, maxTokensPerRepository:0});
  // Read-only mode survives retries after budget stops.
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:1, maxTokensPerRepository:0});
  const limitedReview = await start('Review again', {mode:'review'});
  await state(limitedReview.id, 'budget_exceeded');
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:0, maxTokensPerRepository:0});
  await action(limitedReview.id, 'retry');
  const retriedReview = await state(limitedReview.id, 'completed');
  assert.equal(retriedReview.mode, 'review'); assert.equal(retriedReview.phase, 'analysis');
  assert.ok(retriedReview.events.every((event) => event.type !== 'run.approved'));
  assert.equal(git('status', '--porcelain'), '');

  // A saved lower quota stops active tasks and prevents queued worktrees/CLI calls.
  await request('/api/settings','PUT',{maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:0});
  const quotaActive=await start('slow quota check');
  await until(async()=>(await run(quotaActive.id)).logs?.some(log=>log.message==='ready'));
  const queued=await start('queued quota check');
  assert.equal((await run(queued.id)).executionSeq,0);
  const used=(await request('/api/usage').then(r=>r.json())).totalTokens;
  await request('/api/settings','PUT',{maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:used});
  const blocked=await state(queued.id,'budget_exceeded');
  assert.equal(blocked.executionSeq,0);assert.equal(blocked.worktree,null);
  await state(quotaActive.id,'budget_exceeded');
  await request('/api/settings','PUT',{maxConcurrentRuns:1,maxTokensPerRun:0,maxTokensPerRepository:used+15});
  const gated=await start('gated quota');
  await until(async()=>(await run(gated.id)).logs?.some(log=>log.message==='ready'));
  const behind=await start('wait for quota gate');
  await writeFile(path.join(dir,'release-quota'),'ready');
  await state(gated.id,'budget_exceeded');
  const depleted=await state(behind.id,'budget_exceeded');
  assert.equal(depleted.executionSeq,0);assert.equal(depleted.worktree,null);
  await request('/api/settings','PUT',initialSettings);

  // An occupied-port launch must never restore or execute saved queued tasks.
  const occupiedData = path.join(dir, 'occupied'); await mkdir(occupiedData);
  await writeFile(path.join(occupiedData, 'runs.json'), '{broken');
  const second = spawn(process.execPath, ['server.mjs'], {cwd:root, env:{...env, PORT:new URL(url).port, CODEX_CONTROL_PLANE_DATA_DIR:occupiedData}, stdio:['ignore','pipe','pipe']});
  let errors=''; second.stderr.on('data', (c) => errors += c);
  const [code] = await once(second, 'exit');
  assert.equal(code, 1); assert.match(errors, /already in use/); assert.doesNotMatch(errors, /Original file preserved/);
  assert.equal(await readFile(path.join(occupiedData, 'runs.json'), 'utf8'), '{broken');
  const last = await start('slow shutdown');
  await until(async () => (await run(last.id)).logs?.some((log) => log.message === 'ready'));
  child.kill('SIGTERM');
  await done;
  const saved = JSON.parse(await readFile(path.join(data, 'runs.json'), 'utf8'));
  assert.equal(saved.find((r) => r.id === last.id).state, 'cancelled');
  assert.equal(saved.find((r) => r.id === last.id).starting, false);
});
