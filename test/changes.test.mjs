import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// These checks use real Git patches and a local fixture, without model requests.
test('approval patches include staged, committed and mixed changes; retries restore the original baseline', {skip:process.platform === 'win32', timeout:30000}, async (t) => {
  // macOS exposes /var through /private/var; Git reports the canonical path.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ccp-changes-')));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  await mkdir(repo); await mkdir(bin);
  const git = (...args) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'README.md'), 'baseline\n');
  await writeFile(path.join(repo, 'old.txt'), 'rename me\n');
  await writeFile(path.join(repo, 'obsolete.txt'), 'remove me\n');
  git('add', '.'); git('commit', '-qm', 'Baseline');
  const base = git('rev-parse', 'HEAD');
  const codex = path.join(bin, 'codex');
  await writeFile(codex, `#!${process.execPath}
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const task = process.argv.at(-1);
if (process.argv.includes('workspace-write')) {
  if (task.includes('retry') && !fs.existsSync(process.env.CCP_TEST_ATTEMPT)) {
    fs.writeFileSync(process.env.CCP_TEST_ATTEMPT, '1');
    fs.writeFileSync('failed-artifact.txt', 'must be removed');
    fs.writeFileSync('README.md', 'failed attempt');
    git('add', '.'); git('commit', '-qm', 'Failed attempt');
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'失败前的部分报告'}}));
    console.error('simulated failure'); process.exit(1);
  }
  if (task.includes('retry') && (fs.existsSync('failed-artifact.txt') || git('rev-parse', 'HEAD') !== process.env.CCP_TEST_BASE)) {
    console.error('Retry did not restore the approved baseline'); process.exit(2);
  }
  fs.writeFileSync('README.md', '已批准的改动 😀\\n');
  if (task.includes('staged') || task.includes('committed') || task.includes('mixed')) git('add', 'README.md');
  if (task.includes('committed') || task.includes('mixed')) git('commit', '-qm', 'Agent commit');
  if (task.includes('mixed')) {
    fs.appendFileSync('README.md', 'final working-tree change\\n');
    git('mv', 'old.txt', 'renamed.txt');
    fs.unlinkSync('obsolete.txt');
    fs.writeFileSync('新增文件.txt', 'untracked 中文\\n');
    fs.writeFileSync('binary.dat', Buffer.from([0, 255, 13, 10, 128]));
  }
}
// Split a multi-byte character across pipe chunks on purpose.
const output = Buffer.from(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'检查完成 😀'}}) + '\\n');
if (task.includes('unexpected event')) { console.log('null');console.log('x'.repeat(1024*1024+1)); }
const split = output.indexOf(Buffer.from('检')) + 1;
process.stdout.write(output.subarray(0, split));
setTimeout(() => {
  process.stdout.write(output.subarray(split));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:10, output_tokens:5}}));
}, 40);
`, {mode:0o755});
  const child = spawn(process.execPath, ['server.mjs'], {cwd:root, env:{...process.env, PORT:'0', CODEX_CONTROL_PLANE_DATA_DIR:path.join(dir,'data'), CODEX_CONTROL_PLANE_GIT_BIN:'', CODEX_CONTROL_PLANE_CODEX_BIN:codex, CCP_TEST_BASE:base, CCP_TEST_ATTEMPT:path.join(dir,'attempt')}, stdio:['ignore','pipe','pipe']});
  let output = ''; child.stdout.on('data', c=>output+=c); child.stderr.on('data', c=>output+=c);
  const done = once(child, 'exit');
  t.after(async () => {
    child.kill('SIGTERM'); await done;
    for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
      if (line.startsWith('worktree ') && line.slice(9) !== repo) git('worktree','remove','--force',line.slice(9));
    }
    await rm(dir, {recursive:true,force:true});
  });
  async function until(predicate) {
    for (let i=0;i<200;i++) { const value=await predicate(); if(value) return value; await delay(20); }
    throw new Error(`Timed out: ${output}`);
  }
  const url = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  async function request(route, method='GET', body) {
    const response = await fetch(url + route, {method, headers:{'content-type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
    return {status:response.status, body:await response.json()};
  }
  const action = (id, op) => request(`/api/runs/${id}/${op}`, 'POST');
  const getRun = async (id) => (await request(`/api/runs/${id}`)).body;
  async function settled(id) {
    return until(async () => { const run=await getRun(id); return !run.starting && !['queued','running','approved'].includes(run.state) && run; });
  }
  async function create(prompt) {
    const response=await request('/api/runs','POST',{repository:repo,prompt});
    assert.equal(response.status,202,JSON.stringify(response.body));
    const run=await settled(response.body.id);
    assert.equal(run.state,'awaiting_approval',run.error);
    return run;
  }

  git('config', 'diff.noprefix', 'true');
  git('config', 'color.ui', 'always');
  for (const mode of ['staged','committed','mixed']) {
    await t.test(`${mode} changes are reviewed and applied as the exact final file contents`, async () => {
      const run=await create(mode);
      assert.equal((await action(run.id,'approve')).status,202);
      const changed=await settled(run.id);
      assert.equal(changed.state,'awaiting_merge','Code changes must never be silently treated as an empty diff');
      assert.equal(await readFile(path.join(repo,'README.md'),'utf8'),'baseline\n');
      assert.match(changed.output,/检查完成 😀/);
      assert.doesNotMatch(changed.diff,/\uFFFD/);
      const check=await request(`/api/runs/${run.id}/change-check`);
      assert.equal(check.status,200);assert.equal(check.body.canApply,true);assert.equal(check.body.revision,changed.revision);
      assert.equal(git('status','--porcelain'),'');
      if(mode==='staged') {
        await writeFile(path.join(repo,'README.md'),'user change\n');
        const conflict=await request(`/api/runs/${run.id}/change-check`);
        assert.equal(conflict.body.canApply,false);assert.match(conflict.body.error,/Original repository changed/);
        assert.equal(await readFile(path.join(repo,'README.md'),'utf8'),'user change\n');
        await writeFile(path.join(repo,'README.md'),'baseline\n');
      }
      assert.equal((await action(run.id,'apply')).status,202);
      assert.equal(await readFile(path.join(repo,'README.md'),'utf8'), '已批准的改动 😀\n' + (mode==='mixed' ? 'final working-tree change\n' : ''));
      if(mode==='mixed') {
        assert.equal(await readFile(path.join(repo,'renamed.txt'),'utf8'),'rename me\n');
        await assert.rejects(readFile(path.join(repo,'obsolete.txt')), {code:'ENOENT'});
        assert.equal(await readFile(path.join(repo,'新增文件.txt'),'utf8'),'untracked 中文\n');
        assert.deepEqual(await readFile(path.join(repo,'binary.dat')), Buffer.from([0,255,13,10,128]));
      }
      git('reset','--hard',base);
      git('clean','-fd');
    });
  }
  await t.test('failed agent commits are removed on retry', async () => {
    const run=await create('retry');
    await action(run.id,'approve');
    const failed=await settled(run.id);
    assert.equal(failed.state,'failed');assert.match(failed.output,/失败前的部分报告/);
    assert.equal(failed.executions.at(-1).status,'failed');assert.match(failed.executions.at(-1).diagnostics,/simulated failure/);
    assert.equal((await action(run.id,'retry')).status,202);
    const retried=await settled(run.id);
    assert.equal(retried.state,'awaiting_merge',retried.error);
    assert.doesNotMatch(retried.diff,/failed-artifact/);
    assert.ok(retried.executions.some(entry=>entry.status==='failed' && entry.output.includes('失败前的部分报告')));
    await action(run.id,'discard');
  });
  await t.test('a missing temporary worktree can be recreated for retry without changing the baseline', async () => {
    await rm(path.join(dir,'attempt'), {force:true});
    const run=await create('retry');
    await action(run.id,'approve');
    const failed=await settled(run.id);
    assert.equal(failed.state,'failed');
    git('worktree','remove','--force',failed.worktree);
    assert.equal((await action(run.id,'retry')).status,202);
    const retried=await settled(run.id);
    assert.equal(retried.state,'awaiting_merge',retried.error);
    assert.equal(retried.baseHead,base);
    assert.doesNotMatch(retried.diff,/failed-artifact/);
    await action(run.id,'discard');
  });
  await t.test('task text preserves UTF-8 characters across request chunks', async () => {
    const prompt='分块中文任务 😀';
    const payload=Buffer.from(JSON.stringify({repository:repo,prompt,mode:'review'}));
    const split=payload.indexOf(Buffer.from('分'))+1;
    const response=await new Promise((resolve,reject) => {
      const req=httpRequest(url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'}},res=>{
        let body=''; res.setEncoding('utf8'); res.on('data',c=>body+=c);
        res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
        res.on('error',reject);
      });
      req.on('error',reject);
      req.write(payload.subarray(0,split));
      setTimeout(()=>req.end(payload.subarray(split)),40);
    });
    assert.equal(response.status,202);
    assert.equal(response.body.prompt,prompt);
    assert.equal((await settled(response.body.id)).state,'completed');
  });
  await t.test('unexpected and oversized events do not stop the Runner or discard later reports', async () => {
    const response=await request('/api/runs','POST',{repository:repo,prompt:'unexpected event',mode:'review'});
    assert.equal(response.status,202);const run=await settled(response.body.id);
    assert.equal(run.state,'completed',run.error);assert.match(run.output,/检查完成 😀/);
    assert.ok(run.logs.some(log=>log.type==='output.truncated'));assert.equal(run.usage.totalTokens,15);
  });
  await t.test('retry refuses a changed source baseline', async () => {
    await rm(path.join(dir,'attempt'), {force:true});
    const run=await create('retry');
    await action(run.id,'approve');
    assert.equal((await settled(run.id)).state,'failed');
    git('commit','--allow-empty','-qm','User moved source branch');
    const refused=await action(run.id,'retry');
    assert.equal(refused.status,400);
    assert.match(refused.body.error,/HEAD or branch changed/);
    git('reset','--hard',base);
    await request(`/api/runs/${run.id}`, 'DELETE');
  });
});
