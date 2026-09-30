import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {cleanupOwnedWorktree, inspectOwnedWorktree} from '../lib/worktrees.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccp-owned-')));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const repo = path.join(dir, '原仓库 repo'), root = path.join(dir, 'worktrees');
  await mkdir(repo); await mkdir(root);
  const git = async (cwd, args) => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await git(repo, ['config', 'user.name', 'Test']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'README.md'), 'baseline\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'Initial']);
  async function add(id) {
    const run = {id, repository:repo, branch:`codex-control-plane/${id}`, worktree:path.join(root, id)};
    await git(repo, ['worktree', 'add', '-b', run.branch, run.worktree, 'HEAD']);
    return run;
  }
  return {dir, repo, root, git, add};
}

test('owned cleanup supports detached agent work and paths containing spaces and Unicode', async t => {
  const f = await fixture(t); const run = await f.add('detached'); const file = run.worktree;
  await f.git(file, ['checkout', '--detach']);
  await writeFile(path.join(file, 'README.md'), 'agent work');
  await cleanupOwnedWorktree(run, f);
  assert.equal(run.worktree, null);
  await assert.rejects(access(file), {code:'ENOENT'});
  assert.equal(await f.git(f.repo, ['branch', '--list', run.branch]), '');
  assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), 'baseline\n');
});

test('cleanup removes only its own missing worktree registration and remains repeatable', async t => {
  const f = await fixture(t); const run = await f.add('missing'); const peer = await f.add('peer');
  const saved = structuredClone(run);
  await rm(run.worktree, {recursive:true}); await rm(peer.worktree, {recursive:true});
  await cleanupOwnedWorktree(run, f);
  assert.equal(run.worktree, null);
  const registry = await f.git(f.repo, ['worktree', 'list', '--porcelain', '-z']);
  assert.ok(!registry.includes(saved.branch)); assert.ok(registry.includes(peer.branch));
  await cleanupOwnedWorktree(saved, f);
  assert.equal(saved.worktree, null);
});

test('cleanup refuses directory symlinks and junctions without following them', async t => {
  const f = await fixture(t); const run = await f.add('redirected');
  const outside = path.join(f.dir, 'user-worktree');
  await f.git(f.repo, ['worktree', 'move', run.worktree, outside]);
  await symlink(outside, run.worktree, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupOwnedWorktree(run, f), /does not belong to this task/);
  assert.equal(await readFile(path.join(outside, 'README.md'), 'utf8'), 'baseline\n');
});

test('worktree ownership rejects a Git link copied from another task in the same repository', async t => {
  const f = await fixture(t); const run = await f.add('redirected-link'); const peer = await f.add('peer-link');
  // Replace the link rather than truncating Git for Windows' hidden .git file.
  await rm(path.join(run.worktree, '.git'));
  await writeFile(path.join(run.worktree, '.git'), await readFile(path.join(peer.worktree, '.git')));
  await writeFile(path.join(run.worktree, 'README.md'), 'keep this change');
  await assert.rejects(inspectOwnedWorktree(run, f), /does not belong to this task/);
  await assert.rejects(cleanupOwnedWorktree(run, f), /does not belong to this task/);
  assert.equal(await readFile(path.join(run.worktree, 'README.md'), 'utf8'), 'keep this change');
  assert.equal(await readFile(path.join(peer.worktree, 'README.md'), 'utf8'), 'baseline\n');
});

test('a timed-out Git removal propagates its cause and leaves cleanup retryable', async t => {
  const f = await fixture(t); const run = await f.add('timed-out'); const before = structuredClone(run);
  const failure = Object.assign(new Error('Git command timed out'), {code:'COMMAND_TIMEOUT'});
  const git = (cwd, args) => args[0] === 'worktree' && args[1] === 'remove' ? Promise.reject(failure) : f.git(cwd, args);
  await assert.rejects(cleanupOwnedWorktree(run, {...f, git}), error => error === failure);
  assert.deepEqual(run, before); await access(run.worktree);
  await cleanupOwnedWorktree(run, f);
  assert.equal(run.worktree, null);
});
