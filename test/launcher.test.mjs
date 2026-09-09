import test from 'node:test';
import assert from 'node:assert/strict';
import http, { Agent, createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { applicationId, inspectRunner, selectRunner, openDashboard, runnerUrl } from '../lib/launcher.mjs';

async function server(t, respond) {
  const http = createServer(respond);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  const port = http.address().port;
  return {http, port, url:runnerUrl(port)};
}

test('opening a known local Runner reuses it without acquiring shutdown ownership', async t => {
  const endpoint = await server(t, (req, res) => {
    assert.equal(req.url, '/api/health');
    res.end(JSON.stringify({app:applicationId, ready:true, version:'0.4.0'}));
  });
  const selection = await selectRunner({port:endpoint.port, start:() => assert.fail('must not start a second Runner')});
  assert.equal(selection.reused, true); assert.equal(selection.url, endpoint.url); assert.equal(selection.shutdown, null);
  assert.equal((await inspectRunner(endpoint.url)).ready, true);
});

test('unrelated, old, unready and oversized port responses cannot be reused or replaced', async t => {
  let mode = 'unrelated';
  const endpoint = await server(t, (_req, res) => {
    if (mode === 'oversized') return res.end('x'.repeat(9000));
    res.end(JSON.stringify(mode === 'unrelated' ? {ready:true, version:'0.3.1'} : {app:applicationId, ready:false, version:'0.4.0'}));
  });
  const select = () => selectRunner({port:endpoint.port, start:() => assert.fail('must not replace the listener')});
  await assert.rejects(select(), /older Runner or another application/);
  mode = 'unready'; await assert.rejects(select(), /starting or stopping/);
  mode = 'oversized'; await assert.rejects(select(), /valid Runner response/);
  assert.equal(endpoint.http.listening, true);
});

test('an unused port starts an owned Runner; port zero returns the actual bound address', async t => {
  const endpoint = await server(t, (_req, res) => res.end());
  await new Promise(resolve => endpoint.http.close(resolve));
  assert.equal(await inspectRunner(endpoint.url), null);
  let starts = 0;
  const shutdown = () => {};
  const start = async () => { starts++; return {url:runnerUrl(12345), shutdown}; };
  const owned = await selectRunner({port:endpoint.port, start});
  assert.equal(owned.reused, false); assert.equal(owned.shutdown, shutdown);
  const randomPort = await selectRunner({port:0, start, inspect:() => assert.fail('port zero has no existing endpoint')});
  assert.equal(randomPort.url, runnerUrl(12345)); assert.equal(starts, 2);
});

test('an unresponsive local listener times out without being stopped', async t => {
  const endpoint = await server(t, () => {});
  await assert.rejects(inspectRunner(endpoint.url, {timeoutMs:30}), {code:'RUNNER_PROBE_TIMEOUT'});
  assert.equal(endpoint.http.listening, true);
});

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const nativeProxySupported = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 5) || (nodeMajor === 22 && nodeMinor >= 21);
test('loopback probes bypass a configured global HTTP proxy without changing it', {skip:!nativeProxySupported}, async t => {
  let localRequests = 0, proxyRequests = 0;
  const local = await server(t, (_req, res) => { localRequests++; res.end(JSON.stringify({app:applicationId, ready:true, version:'0.4.1'})); });
  const proxy = await server(t, (_req, res) => { proxyRequests++; res.writeHead(503); res.end('proxy fixture'); });
  const original = http.globalAgent;
  const configured = new Agent({proxyEnv:{HTTP_PROXY:proxy.url, NO_PROXY:''}});
  http.globalAgent = configured;
  t.after(() => { http.globalAgent = original; configured.destroy(); });
  // First establish that the ordinary global client really goes through the proxy.
  await new Promise((resolve, reject) => {
    http.get(local.url, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  assert.equal(proxyRequests, 1); assert.equal(localRequests, 0);
  assert.equal((await inspectRunner(local.url)).ready, true);
  assert.equal(proxyRequests, 1); assert.equal(localRequests, 1); assert.equal(http.globalAgent, configured);
});

test('a healthy Runner slower than the old two-second limit can still be reused', {timeout:10000}, async t => {
  const endpoint = await server(t, (_req, res) => {
    const timer = setTimeout(() => res.end(JSON.stringify({app:applicationId, ready:true, version:'0.4.1'})), 2200);
    res.on('close', () => clearTimeout(timer));
  });
  const selected = await selectRunner({port:endpoint.port, start:() => assert.fail('healthy Runner must be reused')});
  assert.equal(selected.reused, true);
});

test('continuous partial responses cannot extend the overall probe deadline', {timeout:3000}, async t => {
  const endpoint = await server(t, (_req, res) => {
    res.write('{');
    const timer = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(inspectRunner(endpoint.url, {timeoutMs:100}), {code:'RUNNER_PROBE_TIMEOUT'});
  assert.equal(endpoint.http.listening, true);
});

test('opening the dashboard uses platform arguments without a shell and reports missing browsers', async () => {
  for (const [platform, command, args] of [
    ['darwin', 'open', ['http://127.0.0.1:4310/']],
    ['linux', 'xdg-open', ['http://127.0.0.1:4310/']],
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4310/']],
  ]) {
    const opened = await openDashboard(runnerUrl(4310), {platform, spawnProcess:(actual, actualArgs, options) => {
      assert.equal(actual, command); assert.deepEqual(actualArgs, args); assert.equal(options.shell, undefined);
      const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
    }});
    assert.equal(opened, true);
  }
  assert.equal(await openDashboard(runnerUrl(4310), {spawnProcess:() => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child;
  }}), false);
  assert.throws(() => openDashboard('https://example.invalid/'), /local dashboard/);
  assert.throws(() => openDashboard('http://127.0.0.1:4310/?command=bad'), /local dashboard/);
  assert.throws(() => inspectRunner('http://example.invalid:4310'), /local Runner/);
});
