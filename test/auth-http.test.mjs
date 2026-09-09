import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { selectRunner } from '../lib/launcher.mjs';

// A private temporary executable simulates OAuth and tasks. No real credentials,
// browser authorization, model requests or user repositories are used.
test('local HTTP login enforces task exclusion, streams sanitized status and cleans up processes', {skip:process.platform === 'win32', timeout:20000}, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ccp-auth-http-')));
  const repo = path.join(dir, 'repo'), data = path.join(dir, 'data'), executable = path.join(dir, 'codex');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(path.join(repo, 'README.md'), 'fixture baseline\n'); git('add', '.'); git('commit', '-qm', 'Initial');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = name => path.join(process.env.CCP_AUTH_FIXTURE_DIR, name);
if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.error('private-fixture-status'); process.exit(fs.existsSync(file('saved')) ? 0 : 1);
}
if (process.argv[2] === 'login') {
  fs.appendFileSync(file('starts'), 'login\\n'); fs.writeFileSync(file('login-pid'), String(process.pid));
  console.error('private-fixture-login-output');
  console.log('https://auth.openai.com/oauth/authorize?response_type=code&client_id=fixture&state=fixture-state&code_challenge=fixture-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
  setInterval(() => { if (fs.existsSync(file('authorize'))) { fs.writeFileSync(file('saved'), 'simulated'); process.exit(0); } }, 20);
} else {
  console.log(JSON.stringify({type:'output', message:'task ready'})); setInterval(() => {}, 1000);
}
`, {mode:0o755});
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd:fileURLToPath(new URL('..', import.meta.url)),
    env:{...process.env, PORT:'0', CODEX_CONTROL_PLANE_DATA_DIR:data, CODEX_CONTROL_PLANE_CODEX_BIN:executable, CODEX_CONTROL_PLANE_GIT_BIN:'', CCP_AUTH_FIXTURE_DIR:dir},
    stdio:['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const done = once(child, 'exit');
  const abort = new AbortController();
  let streaming;
  t.after(async () => {
    abort.abort(); await streaming;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 6000);
    try { await done; } finally { clearTimeout(force); }
    for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
      if (line.startsWith('worktree ') && line.slice(9) !== repo) git('worktree', 'remove', '--force', line.slice(9));
    }
    await rm(dir, {recursive:true, force:true});
  });
  async function until(predicate) {
    for (let i = 0; i < 400; i++) { const value = await predicate(); if (value) return value; await delay(15); }
    throw new Error(`HTTP auth fixture did not settle: ${output}`);
  }
  const url = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const request = (route, method = 'GET', body) => fetch(url + route, {method, headers:{'content-type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  const status = () => request('/api/auth/status').then(response => response.json());
  const authState = target => until(async () => { const value = await status(); return value.state === target && (target !== 'waiting' || value.loginUrl) && value; });
  const pid = async () => Number(await readFile(path.join(dir, 'login-pid'), 'utf8'));
  const starts = async () => (await readFile(path.join(dir, 'starts'), 'utf8')).trim().split('\n').length;

  const attached = await selectRunner({port:Number(new URL(url).port), start:() => assert.fail('existing Runner must be reused')});
  assert.equal(attached.reused, true); assert.equal(attached.shutdown, null);
  const foreign = await fetch(url + '/api/auth/login', {method:'POST', headers:{origin:'https://example.invalid'}});
  assert.equal(foreign.status, 403);
  assert.equal((await request('/api/auth/refresh', 'POST').then(r => r.json())).state, 'signed_out');

  let events = '';
  const stream = await fetch(url + '/api/events', {signal:abort.signal});
  streaming = (async () => { try { for await (const chunk of stream.body) events += new TextDecoder().decode(chunk); } catch (error) { if (error.name !== 'AbortError') throw error; } })();
  assert.equal((await request('/api/auth/login', 'POST')).status, 202);
  await authState('waiting'); const cancelledPid = await pid();
  assert.equal((await request('/api/auth/login', 'POST')).status, 202); assert.equal(await starts(), 1);
  assert.equal((await request('/api/runs', 'POST', {repository:repo, prompt:'Blocked during login'})).status, 409);
  assert.equal((await request('/api/runtime', 'PUT', {codexPath:executable})).status, 409);
  assert.equal((await request('/api/auth/cancel', 'POST').then(r => r.json())).state, 'cancelled');
  assert.throws(() => process.kill(cancelledPid, 0), {code:'ESRCH'});

  await request('/api/auth/login', 'POST'); await authState('waiting');
  await writeFile(path.join(dir, 'authorize'), 'complete simulated login');
  const loggedIn = await authState('signed_in');
  assert.equal(loggedIn.busy, false); assert.equal(loggedIn.loginUrl, null);
  await until(() => events.includes('"state":"signed_in"'));
  assert.match(events, /event: auth/); assert.match(events, /auth\.openai\.com/);
  assert.doesNotMatch(events, /private-fixture/);
  await request('/api/auth/login', 'POST'); await authState('signed_in');
  assert.equal(await starts(), 2); // existing credentials do not open another login
  assert.doesNotMatch(await readFile(path.join(data, 'runs.json'), 'utf8'), /private-fixture|auth\.openai\.com/);

  await request('/api/settings', 'PUT', {maxConcurrentRuns:1, maxTokensPerRun:0, maxTokensPerRepository:0});
  const startRun = async () => {
    const result = await request('/api/runs', 'POST', {repository:repo, prompt:'Simulated read-only task', mode:'review'});
    assert.equal(result.status, 202); return result.json();
  };
  const active = await startRun();
  const getRun = id => request('/api/runs/' + id).then(r => r.json());
  await until(async () => (await getRun(active.id)).logs.some(log => log.message === 'task ready'));
  const queued = await startRun(); assert.equal(queued.state, 'queued');
  assert.equal((await request('/api/auth/login', 'POST')).status, 409);
  await request(`/api/runs/${queued.id}/cancel`, 'POST'); await request(`/api/runs/${active.id}/cancel`, 'POST');
  await until(async () => { const run = await getRun(active.id); return run.state === 'cancelled' && !run.starting; });
  assert.equal(git('status', '--porcelain'), '');

  await rm(path.join(dir, 'saved')); await rm(path.join(dir, 'authorize'));
  await request('/api/auth/login', 'POST'); await authState('waiting'); const stoppingPid = await pid();
  child.kill('SIGTERM'); assert.equal((await done)[0], 0);
  assert.throws(() => process.kill(stoppingPid, 0), {code:'ESRCH'});
});
