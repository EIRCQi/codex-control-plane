import test from 'node:test';
import assert from 'node:assert/strict';
import { messageText } from '../public/locale.js';
import { createEventBuffer } from '../public/event-viewer.js';

test('message presentation retains unknown tool content and dynamic diagnostic details', () => {
  for (const raw of ['constructor', '__proto__', '', 'fatal: cannot access /项目/<path>', 'Retry 2 queued\nconsole.log("Keep code unchanged")']) assert.equal(messageText(raw), raw);
  const details = 'C:\\Users\\名字\\codex.exe: EACCES <details>';
  assert.ok(messageText(`Cannot execute codex at ${details}`).endsWith(details));
  assert.match(messageText('Repository token quota reached (1,000 / 900)'), /1,000 \/ 900/);
});

test('event search accepts Chinese labels and original identifiers while preserving raw records', () => {
  const run = {id:'locale-fixture', logs:[{at:'2026-09-10T00:00:00Z', type:'turn.completed', message:'Original <code> 输出'}, {at:'2026-09-10T00:00:01Z', type:'custom.event', message:'raw'}]};
  const original = structuredClone(run);
  const buffer = createEventBuffer(); buffer.update(run);
  for (const query of ['执行轮次完成', 'turn.completed']) {
    buffer.search(query); assert.deepEqual(buffer.view().logs, [run.logs[0]]);
  }
  assert.deepEqual(run, original);
});
