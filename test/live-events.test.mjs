import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunPublisher } from '../lib/live-events.mjs';

test('bursts publish the latest snapshot once per run, while approval transitions stay immediate', async (t) => {
  const sent = [];
  const publisher = createRunPublisher((run) => sent.push(structuredClone(run)), 10);
  t.after(() => publisher.clear());
  for (let i=0; i<100; i++) publisher.schedule({id:'one', state:'running', sequence:i});
  publisher.schedule({id:'two', state:'running', sequence:1});
  await delay(30);
  assert.equal(sent.length,2);
  assert.equal(sent.find((run) => run.id==='one').sequence,99);
  publisher.schedule({id:'one', state:'running', sequence:100});
  publisher.immediate({id:'one', state:'awaiting_approval'});
  assert.equal(sent.at(-1).state,'awaiting_approval');
  await delay(30);
  assert.equal(sent.length,3,'No stale log snapshot may follow an approval transition');
});

test('shutdown clears queued log publications', async () => {
  const sent = [];
  const publisher = createRunPublisher((run) => sent.push(run),10);
  publisher.schedule({id:'one'});
  publisher.clear();
  await delay(30);
  assert.deepEqual(sent,[]);
});
