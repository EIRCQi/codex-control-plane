import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuthManager, safeLoginUrl } from '../lib/auth.mjs';

const loginUrl = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=fixture&state=fixture-state&code_challenge=fixture-challenge&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
const signedOut = {ok:false, code:1, output:'private-status-output'};
const signedIn = {ok:true, code:0, output:'private-status-output'};
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw new Error('Auth fixture did not reach the expected state');
}
function fixture(t, options = {}) {
  const children = [], updates = [], calls = [];
  let probes = 0;
  const manager = createAuthManager({
    getExecutable:async () => '/fixture/codex', env:{FIXTURE:'1'}, killAfterMs:15,
    probeLogin:async (...args) => { calls.push(args); return ++probes === 1 ? signedOut : signedIn; },
    spawnProcess:(command, args, config) => {
      calls.push([command, args, config]);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
      child.finish = code => { if (child.closed) return; child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
      child.kill = signal => { child.signals.push(signal); if (!child.resist || signal === 'SIGKILL') queueMicrotask(() => child.finish(null)); return true; };
      children.push(child);
      return child;
    },
    onChange:value => updates.push(value), ...options,
  });
  t.after(() => manager.shutdown());
  return {manager, children, updates, calls};
}

test('fallback login links must be OpenAI authorization requests with a local callback and no tokens', () => {
  assert.equal(safeLoginUrl(loginUrl), loginUrl);
  for (const invalid of [loginUrl.replace('auth.openai.com', 'auth.openai.com.example.invalid'), loginUrl.replace('https:', 'http:'), loginUrl.replace('localhost', 'example.invalid'), loginUrl.replace('response_type=code', 'response_type=token'), loginUrl.replace('state=fixture-state&', ''), loginUrl + '&access_token=private', loginUrl + '&code=private', loginUrl + '#private', 'javascript:alert(1)']) assert.equal(safeLoginUrl(invalid), null);
});

test('login reuses existing CLI credentials and never exposes credential-status output', async t => {
  const h = fixture(t, {probeLogin:async () => signedIn});
  assert.equal(h.manager.start().busy, true);
  await until(() => !h.manager.isLoggingIn());
  assert.equal(h.manager.snapshot().state, 'signed_in');
  assert.equal(h.children.length, 0);
  assert.doesNotMatch(JSON.stringify(h.updates), /private-status-output/);
});

test('rechecking a missing executable recovers, while failed status probes never start login', async t => {
  let available = false;
  const h = fixture(t, {getExecutable:() => { if (!available) throw new Error('private-path-error'); return '/fixture/codex'; }, probeLogin:async () => ({ok:false, code:null, reason:'TIMEOUT'})});
  assert.equal((await h.manager.refresh()).state, 'missing');
  available = true;
  assert.equal((await h.manager.refresh()).state, 'error');
  h.manager.start(); await until(() => !h.manager.isLoggingIn());
  assert.equal(h.children.length, 0); assert.equal(h.manager.snapshot().state, 'error');
  assert.doesNotMatch(JSON.stringify(h.updates), /private-path-error/);
});

test('duplicate login starts share one process, parse split links and confirm the saved login', async t => {
  const h = fixture(t);
  h.manager.start(); h.manager.start();
  await until(() => h.children.length === 1);
  const child = h.children[0];
  child.stderr.write('private-cli-output\nhttps://example.invalid/?access_token=private\n');
  child.stderr.write('Open this URL: ' + loginUrl.slice(0, 80));
  assert.equal(h.manager.snapshot().loginUrl, null);
  child.stderr.write(loginUrl.slice(80) + '\n');
  assert.equal(h.manager.snapshot().loginUrl, loginUrl);
  h.manager.start();
  assert.equal(h.children.length, 1);
  child.finish(0); await until(() => !h.manager.isLoggingIn());
  assert.equal(h.manager.snapshot().state, 'signed_in'); assert.equal(h.manager.snapshot().loginUrl, null);
  assert.deepEqual(h.calls.map(call => call[1]), [['login', 'status'], ['login'], ['login', 'status']]);
  assert.equal(h.calls[1][2].shell, undefined);
  assert.doesNotMatch(JSON.stringify(h.updates), /private-cli-output|private-status-output|example.invalid/);
});

test('successful CLI exit without saved credentials remains an error', async t => {
  const h = fixture(t, {probeLogin:async () => signedOut});
  h.manager.start(); await until(() => h.children.length);
  h.children[0].finish(0); await until(() => !h.manager.isLoggingIn());
  assert.equal(h.manager.snapshot().state, 'error');
  assert.match(h.manager.snapshot().message, /could not be confirmed/);
});

test('cancel during preflight prevents a delayed login from spawning', async t => {
  let release;
  const h = fixture(t, {probeLogin:() => new Promise(resolve => { release = resolve; })});
  h.manager.start(); await until(() => release);
  const cancelled = h.manager.cancel();
  assert.equal(h.manager.snapshot().state, 'cancelling');
  h.manager.start(); release(signedOut);
  assert.equal((await cancelled).state, 'cancelled');
  assert.equal(h.children.length, 0);
});

test('cancellation waits for exit and escalates resistant processes before allowing retry', async t => {
  const h = fixture(t, {probeLogin:async () => signedOut});
  h.manager.start(); await until(() => h.children.length);
  const child = h.children[0]; child.resist = true;
  const cancelled = h.manager.cancel();
  assert.equal(h.manager.start().state, 'cancelling'); assert.equal(h.children.length, 1);
  await cancelled;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.manager.snapshot().busy, false); assert.equal(h.manager.snapshot().state, 'cancelled');
  h.manager.start(); await until(() => h.children.length === 2);
});

test('login timeout and Runner shutdown close owned login processes', async t => {
  const timed = fixture(t, {timeoutMs:40});
  timed.manager.start(); await until(() => !timed.manager.isLoggingIn());
  assert.equal(timed.manager.snapshot().state, 'timed_out'); assert.equal(timed.children[0].closed, true);
  const stopping = fixture(t);
  stopping.manager.start(); await until(() => stopping.children.length);
  await stopping.manager.shutdown();
  assert.equal(stopping.children[0].closed, true); assert.equal(stopping.manager.snapshot().busy, false);
  assert.throws(() => stopping.manager.start(), /stopping/);
});
