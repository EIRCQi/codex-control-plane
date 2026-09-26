import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fixture, until} from '../test-support/runner.mjs';
import {createRun} from '../lib/workflow.mjs';

const options = {skip:process.platform === 'win32', timeout:20000};
function savedRun(f, state = 'failed') {
  const id = 'cleanup-' + path.basename(f.dir);
  return Object.assign(createRun({id, repository:f.repo, prompt:'Check cleanup'}), {
    state, branch:`codex-control-plane/${id}`,
    worktree:path.join(os.tmpdir(), 'codex-control-plane-worktrees', id),
    baseHead:f.git('rev-parse', 'HEAD'), baseRef:f.git('symbolic-ref', 'HEAD'),
  });
}
const save = (f, run) => writeFile(path.join(f.data, 'runs.json'), JSON.stringify([run]));

test('history deletion refuses paths outside the task directory, including registered worktrees', options, async t => {
  for (const registered of [false, true]) await t.test(String(registered), async t => {
    const f = await fixture(); t.after(() => f.cleanup());
    const run = savedRun(f);
    run.worktree = path.join(f.dir, 'user-files');
    if (registered) f.git('worktree', 'add', '-b', run.branch, run.worktree, 'HEAD');
    else await mkdir(run.worktree);
    await writeFile(path.join(run.worktree, 'keep.txt'), 'preserve user data');
    await save(f, run);
    const s = await f.launch();
    const result = await s.request(`/api/runs/${run.id}`, 'DELETE');
    assert.equal(result.status, 400);
    assert.match(result.body.error, /does not belong to this task/);
    assert.equal(await readFile(path.join(run.worktree, 'keep.txt'), 'utf8'), 'preserve user data');
    assert.equal((await s.run(run.id)).worktree, run.worktree);
  });
});

test('cleanup refuses a saved branch name that belongs to the user', options, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const run = savedRun(f);
  f.git('worktree', 'add', '-b', run.branch, run.worktree, 'HEAD');
  f.git('branch', 'keep-user-branch');
  run.branch = 'keep-user-branch';
  await save(f, run);
  const s = await f.launch();
  assert.equal((await s.request(`/api/runs/${run.id}`, 'DELETE')).status, 400);
  assert.equal(f.git('rev-parse', 'keep-user-branch'), run.baseHead);
  assert.equal(await readFile(path.join(run.worktree, 'README.md'), 'utf8'), 'baseline\n');
});

for (const action of ['reject', 'discard']) {
  test(`${action} retains its approval state and files after a locked worktree refuses cleanup`, options, async t => {
    const f = await fixture(); t.after(() => f.cleanup());
    const run = savedRun(f, action === 'reject' ? 'awaiting_approval' : 'awaiting_merge');
    f.git('worktree', 'add', '-b', run.branch, run.worktree, 'HEAD');
    f.git('worktree', 'lock', '--reason', 'Keep test files', run.worktree);
    await writeFile(path.join(run.worktree, 'keep.txt'), 'preserve locked worktree');
    await save(f, run);
    const s = await f.launch();
    const result = await s.request(`/api/runs/${run.id}/${action}`, 'POST');
    assert.equal(result.status, 400);
    assert.match(result.body.error, /locked/i);
    assert.equal((await s.run(run.id)).state, run.state);
    assert.equal(await readFile(path.join(run.worktree, 'keep.txt'), 'utf8'), 'preserve locked worktree');
    await f.stop(s);
    const restarted = await f.launch();
    assert.equal((await restarted.run(run.id)).state, run.state);
    f.git('worktree', 'unlock', run.worktree);
    assert.equal((await restarted.request(`/api/runs/${run.id}/${action}`, 'POST')).status, 202);
    assert.equal((await restarted.run(run.id)).state, action === 'reject' ? 'cancelled' : 'discarded');
    await assert.rejects(access(run.worktree), {code:'ENOENT'});
  });
}

test('failed branch deletion retains cleanup metadata and can finish after restart', options, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const run = savedRun(f);
  f.git('worktree', 'add', '-b', run.branch, run.worktree, 'HEAD');
  const lock = path.join(f.repo, '.git', 'refs', 'heads', run.branch + '.lock');
  await writeFile(lock, 'blocked by another Git operation');
  await save(f, run);
  const s = await f.launch();
  const result = await s.request(`/api/runs/${run.id}`, 'DELETE');
  assert.equal(result.status, 400);
  assert.equal((await s.run(run.id)).worktree, run.worktree);
  await assert.rejects(access(run.worktree), {code:'ENOENT'});
  assert.equal(f.git('rev-parse', run.branch), run.baseHead);
  await f.stop(s);
  const restarted = await f.launch();
  assert.equal((await restarted.run(run.id)).worktree, run.worktree);
  await rm(lock);
  assert.equal((await restarted.request(`/api/runs/${run.id}`, 'DELETE')).status, 200);
  assert.equal((await restarted.request(`/api/runs/${run.id}`)).status, 404);
  assert.equal(f.git('branch', '--list', run.branch), '');
});

test('retry refuses an unrelated repository placed at the expected worktree path', options, async t => {
  const f = await fixture(); const run = savedRun(f);
  t.after(async () => {await rm(run.worktree, {recursive:true, force:true}); await f.cleanup();});
  execFileSync('git', ['clone', '--quiet', f.repo, run.worktree]);
  run.phase = 'implementation'; run.events.push({type:'run.approved'});
  await writeFile(path.join(run.worktree, 'README.md'), 'unrelated working changes');
  await save(f, run);
  const s = await f.launch();
  const result = await s.request(`/api/runs/${run.id}/retry`, 'POST');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /does not belong to this task/);
  assert.equal(await readFile(path.join(run.worktree, 'README.md'), 'utf8'), 'unrelated working changes');
  assert.equal((await s.run(run.id)).retries, 0);
});

test('cancellation records cleanup failure without losing the worktree or task history', options, async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const s = await f.launch();
  const created = await s.request('/api/runs', 'POST', {repository:f.repo, prompt:'quota peer', mode:'review'});
  const id = created.body.id;
  const active = await until(async () => {
    const run = await s.run(id);
    return run.logs.some(log => log.message === 'peer ready') && run;
  }, 'active review');
  f.git('worktree', 'lock', active.worktree);
  assert.equal((await s.request(`/api/runs/${id}/cancel`, 'POST')).status, 202);
  const stopped = await s.state(id, 'cancelled');
  assert.equal(stopped.worktree, active.worktree);
  assert.match(stopped.error, /Worktree cleanup failed/);
  assert.ok(stopped.events.some(event => event.type === 'worktree.cleanup_failed'));
  await access(active.worktree);
  await f.stop(s);
  const restarted = await f.launch();
  assert.equal((await restarted.run(id)).error, stopped.error);
  f.git('worktree', 'unlock', active.worktree);
  assert.equal((await restarted.request(`/api/runs/${id}`, 'DELETE')).status, 200);
});
