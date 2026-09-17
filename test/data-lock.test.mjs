import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireDataLock} from '../lib/data-lock.mjs';

test('data ownership is exclusive and releases only its own lock',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const release=await acquireDataLock(dir);t.after(release);
  await assert.rejects(acquireDataLock(dir),error=>error.code==='DATA_DIR_LOCKED');
  await release();const nextRelease=await acquireDataLock(dir);const before=await readFile(path.join(dir,'runner.lock'),'utf8');
  await release();assert.equal(await readFile(path.join(dir,'runner.lock'),'utf8'),before);await nextRelease();
});

test('a malformed owner is preserved and never silently replaced',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-lock-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'runner.lock'),'{broken');
  await assert.rejects(acquireDataLock(dir),error=>error.code==='DATA_DIR_LOCKED');
  assert.equal(await readFile(path.join(dir,'runner.lock'),'utf8'),'{broken');
});

test('symlink aliases share one data directory owner',{skip:process.platform==='win32'},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ccp-lock-alias-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const data=path.join(dir,'data'),alias=path.join(dir,'alias');const release=await acquireDataLock(data);t.after(release);
  await symlink(data,alias);await assert.rejects(acquireDataLock(alias),error=>error.code==='DATA_DIR_LOCKED');
});
