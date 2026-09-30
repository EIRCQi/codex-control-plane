import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotWriter, createCollectionWriter } from '../lib/storage.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('snapshot bursts serialize once, and changes during a write share one fresh follow-up', async () => {
  let value=0,captures=0;const writes=[],releases=[];
  const writer=createSnapshotWriter(()=>{captures++;return value;},snapshot=>new Promise(resolve=>{writes.push(snapshot);releases.push(resolve);}));
  const first=Array.from({length:100},(_,i)=>{value=i;return writer.flush();});
  await tick();assert.deepEqual(writes,[99]);assert.equal(captures,1);
  const next=Array.from({length:100},(_,i)=>{value=100+i;return writer.flush();});
  let finished=false;next.at(-1).then(()=>finished=true);
  await tick();assert.equal(captures,1);assert.equal(finished,false);
  releases[0]();await Promise.all(first);await tick();assert.deepEqual(writes,[99,199]);assert.equal(finished,false);
  releases[1]();await Promise.all(next);assert.equal(finished,true);assert.equal(captures,2);
});
test('a failed snapshot rejects its callers and later flushes can recover', async () => {
  let fail=true;const saved=[];
  const writer=createSnapshotWriter(()=>({value:2}),async value=>{if(fail)throw new Error('disk unavailable');saved.push(value);});
  await assert.rejects(writer.flush(),/disk unavailable/);fail=false;await writer.flush();assert.deepEqual(saved,[{value:2}]);
});

test('queued confirmations stay invisible until their covering write and survive a pending background save', async () => {
  const current={first:'waiting',second:'failed',usage:0},writes=[],releases=[];
  const writer=createSnapshotWriter(()=>structuredClone(current),snapshot=>new Promise(resolve=>{writes.push(snapshot);releases.push(resolve);}));
  const background=writer.flush();await tick();
  const confirm=key=>writer.flush({prepare:snapshot=>{snapshot[key]='queued';},commit:()=>{current[key]='queued';}});
  const first=confirm('first'),second=confirm('second');
  let confirmed=false;first.then(()=>confirmed=true);
  assert.equal(current.first,'waiting');assert.equal(current.second,'failed');
  releases[0]();await background;await tick();
  assert.deepEqual(writes[1],{first:'queued',second:'queued',usage:0});
  assert.equal(confirmed,false);assert.equal(current.first,'waiting');
  current.usage=42;const checkpoint=writer.flush();
  releases[1]();await Promise.all([first,second]);await tick();
  assert.equal(confirmed,true);
  assert.deepEqual(current,{first:'queued',second:'queued',usage:42});
  assert.deepEqual(writes[2],current,'the next snapshot must include confirmations committed by the previous write');
  releases[2]();await checkpoint;
});

test('failed confirmations cannot leak into a background save and remain retryable', async () => {
  const current={state:'failed',retries:0},writes=[],releases=[];
  const writer=createSnapshotWriter(()=>structuredClone(current),snapshot=>new Promise((resolve,reject)=>{writes.push(snapshot);releases.push({resolve,reject});}));
  let committed=0;
  const retry=()=>writer.flush({
    prepare:snapshot=>{snapshot.state='queued';snapshot.retries++;},
    commit:()=>{current.state='queued';current.retries++;committed++;},
  });
  const failed=assert.rejects(retry(),/disk unavailable/);await tick();
  const checkpoint=writer.flush();
  releases[0].reject(new Error('disk unavailable'));await failed;await tick();
  assert.equal(committed,0);assert.deepEqual(current,{state:'failed',retries:0});
  assert.deepEqual(writes[1],current,'a rejected retry must never be recorded by another save');
  releases[1].resolve();await checkpoint;
  const accepted=retry();await tick();releases[2].resolve();await accepted;
  assert.equal(committed,1);assert.deepEqual(current,{state:'queued',retries:1});assert.deepEqual(writes[2],current);
});

test('collection writes commit only on success and serialized edits cannot lose each other', async () => {
  let current=new Map([['first',{value:1}]]),fail=false;
  const snapshots=[];
  const update=createCollectionWriter({read:()=>current,write:async next=>{await tick();if(fail)throw new Error('save failed');snapshots.push(structuredClone(next));},commit:next=>current=next});
  const a=update(next=>next.set('second',{value:2}));
  const b=update(next=>next.delete('first'));
  assert.equal(current.has('second'),false);await Promise.all([a,b]);assert.deepEqual([...current.keys()],['second']);
  fail=true;await assert.rejects(update(next=>{next.get('second').value=9;next.set('phantom',{});}),/save failed/);
  assert.equal(current.get('second').value,2);assert.equal(current.has('phantom'),false);
  fail=false;await update(next=>next.set('third',{value:3}));assert.deepEqual([...current.keys()],['second','third']);assert.equal(snapshots.length,3);
});
