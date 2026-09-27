import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, until} from '../test-support/runner.mjs';

test('Runner shutdown cancels active diagnostics, stops their descendants and releases its data lock', {skip:process.platform === 'win32', timeout:15000}, async t => {
  const f = await fixture();
  const parent = path.join(f.dir, 'diagnostic-parent'), worker = path.join(f.dir, 'diagnostic-worker'), ticks = path.join(f.dir, 'diagnostic-ticks');
  t.after(async () => {
    for (const file of [worker, parent]) {try {process.kill(Number(await readFile(file, 'utf8')), 'SIGKILL');} catch {}}
    await f.cleanup();
  });
  const helper = path.join(f.dir, 'diagnostic.cjs');
  await writeFile(helper, `const fs=require('node:fs');let count=0;
process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(worker)},String(process.pid));
const tick=()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++count));tick();setInterval(tick,25);
setTimeout(()=>process.exit(0),12000);
`);
  await writeFile(path.join(f.dir, 'codex'), `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(parent)},String(process.pid));
require('node:child_process').spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:'inherit'});
setInterval(()=>{},1000);
`);
  const s = await f.launch();
  const request = s.request('/api/diagnostics').catch(() => null);
  await until(async () => {try {return await readFile(ticks, 'utf8');} catch {return false;}}, 'active diagnostic descendant');
  s.child.kill('SIGTERM');
  let timer;
  try {
    const exit = await Promise.race([s.done, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Shutdown waited for the diagnostic deadline')), 5500);})]);
    assert.equal(exit.code, 0, s.output);
  } finally {clearTimeout(timer);}
  await request;
  await delay(60); const before = await readFile(ticks, 'utf8');
  await delay(120); assert.equal(await readFile(ticks, 'utf8'), before);
  const restarted = await f.launch();
  assert.equal((await restarted.request('/api/health')).body.ready, true);
});
