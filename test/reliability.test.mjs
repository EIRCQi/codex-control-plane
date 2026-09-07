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
if (args.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }
if (args.includes('login')) { console.log('credential-marker-private'); process.exit(0); }
if (args.at(-1).includes('slow')) {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({type:'output', message:'ready'}));
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

  const foreign = await fetch(url+'/api/runs', {method:'POST',headers:{'content-type':'application/json',origin:'https://example.invalid'},body:JSON.stringify({repository:repo,prompt:'Foreign request'})});
  assert.equal(foreign.status, 403);
  const historical = await request('/api/runs').then(r=>r.json());
  assert.equal(historical.length, 1); assert.equal(historical[0].mode, 'implement');
  const health = await request('/api/health').then(r=>r.json());
  assert.equal(health.version, '0.2.0');
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
