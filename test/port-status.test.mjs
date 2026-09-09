import test from 'node:test';
import assert from 'node:assert/strict';
import { portStatus } from '../lib/port-status.mjs';

test('a timed-out suspended listener gets read-only process and recovery guidance', async () => {
  const calls = [];
  const result = await portStatus({port:4310, platform:'darwin', inspect:async () => { throw new Error('Health response timed out'); }, run:async (command, args) => {
    calls.push([command, args]);
    return {ok:true, code:0, output:command === 'lsof' ? '1234\n1234\n' : '1234  100  T  node\n'};
  }});
  assert.equal(result.healthy, false); assert.match(result.text, /timed out/); assert.match(result.text, /State T/); assert.match(result.text, /fg/); assert.match(result.text, /Ctrl\+C/);
  assert.deepEqual(calls, [['lsof', ['-nP', '-a', '-iTCP:4310', '-sTCP:LISTEN', '-t']], ['ps', ['-p', '1234', '-o', 'pid=,ppid=,stat=,comm=']]]);
});

test('port reporting handles disappearing listeners and unavailable platform commands', async () => {
  const absent = await portStatus({port:4310, platform:'darwin', inspect:async () => null, run:async () => ({ok:false, code:1, output:''})});
  assert.equal(absent.healthy, false); assert.match(absent.text, /No listening process was visible/);
  const missingTool = await portStatus({port:4311, platform:'linux', inspect:async () => ({ready:true, version:'0.4.1'}), run:async () => ({ok:false, reason:'ENOENT', output:''})});
  assert.equal(missingTool.healthy, true); assert.match(missingTool.text, /lsof -nP -iTCP:4311/);
  const windows = await portStatus({port:4310, platform:'win32', inspect:async () => null, run:() => assert.fail('POSIX commands must not run on Windows')});
  assert.match(windows.text, /Get-NetTCPConnection -LocalPort 4310/);
});
