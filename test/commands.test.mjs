import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCommandRunner } from '../lib/commands.mjs';

test('command capture preserves split UTF-8 and reports bounded stderr on failure', async t => {
  const runner=createCommandRunner({maxErrorBytes:32});t.after(()=>runner.shutdown());
  const text=await runner.run(process.execPath,['-e',"const b=Buffer.from('中文🙂');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.end(b.subarray(2)),5)"]);
  assert.equal(text,'中文🙂');
  await assert.rejects(runner.run(process.execPath,['-e',"process.stderr.write('x'.repeat(1000)+'last error');process.exitCode=1"]),error=>error.code==='COMMAND_EXIT' && error.message.length<=32 && error.message.endsWith('last error'));
  assert.equal(runner.size,0);
});
test('oversized stdout is rejected in full and hung commands time out', async t => {
  const runner=createCommandRunner({maxOutputBytes:64,timeoutMs:5000,killDelayMs:20});t.after(()=>runner.shutdown());
  await assert.rejects(runner.run(process.execPath,['-e',"process.stdout.write('x'.repeat(1000));setInterval(()=>{},1000)"]),error=>error.code==='COMMAND_OUTPUT_LIMIT');
  const timeout=createCommandRunner({timeoutMs:100,killDelayMs:20});t.after(()=>timeout.shutdown());
  await assert.rejects(timeout.run(process.execPath,['-e','setInterval(()=>{},1000)']),error=>error.code==='COMMAND_TIMEOUT');assert.equal(timeout.size,0);
});
test('cancellation waits for an owned child to exit; shutdown prevents later commands', {timeout:10000}, async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'ccp-command-')),marker=path.join(dir,'ready');
  const runner=createCommandRunner({timeoutMs:8000,killDelayMs:20});t.after(async()=>{await runner.shutdown();await rm(dir,{recursive:true,force:true});});
  const controller=new AbortController();
  const result=runner.run(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",marker],{signal:controller.signal}).then(value=>({value}),error=>({error}));
  let pid;
  for(let i=0;i<200;i++){try{pid=Number(await readFile(marker,'utf8'));break;}catch{await delay(20);}}
  assert.ok(pid,'child must install its signal handler before cancellation');controller.abort();
  assert.equal((await result).error.code,'COMMAND_ABORTED');assert.equal(runner.size,0);
  assert.throws(()=>process.kill(pid,0));
  await runner.shutdown();await assert.rejects(runner.run(process.execPath,['-e','process.exit(0)']),error=>error.code==='COMMAND_ABORTED');
});
