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
