import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
test('real HTTP/worktree lifecycle, rejection retry, duplicate apply, and cancellation', { skip: process.platform === 'win32', timeout: 25000 }, async (t) => {
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
if (args.at(-1).includes('slow')) {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({type:'output', message:'ready'}));
  setInterval(() => {}, 1000);
} else {
  if (args.includes('workspace-write')) fs.writeFileSync('README.md', 'approved change\\n');
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:10, output_tokens:5}}));
}
`, { mode: 0o755 });
  const data = path.join(dir, 'data');
  const env = { ...process.env, PORT: '0', CODEX_CONTROL_PLANE_DATA_DIR: data, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (c) => output += c); child.stderr.on('data', (c) => output += c);
  const done = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await done; await rm(dir, { recursive: true, force: true }); });
  const until = async (predicate) => { for (let i = 0; i < 600; i++) { const result = await predicate(); if (result) return result; await delay(20); } throw new Error(`Timed out: ${output}`); };
  const url = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const request = (route, method = 'GET', body) => fetch(url + route, { method, headers: { 'content-type':'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const run = (id) => request(`/api/runs/${id}`).then((r) => r.json());
  const state = (id, target) => until(async () => { const r = await run(id); return r.state === target && !r.starting && r; });
  const start = async (prompt) => { const r = await request('/api/runs', 'POST', {repository:repo, prompt}); assert.equal(r.status, 202); return r.json(); };
  const action = (id, op) => request(`/api/runs/${id}/${op}`, 'POST');

  const foreign = await fetch(url+'/api/runs', {method:'POST',headers:{'content-type':'application/json',origin:'https://example.invalid'},body:JSON.stringify({repository:repo,prompt:'Foreign request'})});
  assert.equal(foreign.status, 403);
  assert.deepEqual(await request('/api/runs').then(r=>r.json()), []);
  const first = await start('Improve README');
  await state(first.id, 'awaiting_approval');
  assert.equal((await action(first.id, 'apply')).status, 400);
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'baseline\n');
  await action(first.id, 'reject');
  await action(first.id, 'retry');
  await state(first.id, 'awaiting_approval');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'baseline\n');
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
  await action(slow.id, 'cancel');
  assert.equal((await action(slow.id, 'retry')).status, 400);
  assert.equal((await request(`/api/runs/${slow.id}`, 'DELETE')).status, 400);
  await state(slow.id, 'cancelled'); // resistant CLI must be killed within the grace period
  assert.equal((await request(`/api/runs/${slow.id}`, 'DELETE')).status, 200);

  // Budget termination has the same escalation path as user cancellation.
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:1, maxTokensPerRepository:0});
  const budget = await start('Small budget');
  await state(budget.id, 'budget_exceeded');
  await request('/api/settings', 'PUT', {maxConcurrentRuns:2, maxTokensPerRun:0, maxTokensPerRepository:0});

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
