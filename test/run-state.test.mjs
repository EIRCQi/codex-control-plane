import test from 'node:test';
import assert from 'node:assert/strict';
import { preferRun, executionDuration, formatDuration, runningMessage } from '../public/run-state.js';
import { touchRun } from '../lib/workflow.mjs';

test('revisions disambiguate same-millisecond replies and old Runner replies cannot overwrite a new session', () => {
  const old={id:'r',runnerId:'one',revision:1,updatedAt:'same',state:'queued'};
  const latest={...old,state:'running'};touchRun(latest,'same');
  assert.equal(preferRun(latest,old,'one'),latest);
  const restarted={...old,runnerId:'two',revision:1,state:'failed'};
  assert.equal(preferRun(latest,restarted,'two'),restarted);
  assert.equal(preferRun(restarted,latest,'two'),restarted);
  assert.equal(preferRun(null,old,'two'),null);
  assert.equal(preferRun({updatedAt:'b'},{updatedAt:'a'}).updatedAt,'b');
});

test('live timing adds only the active attempt and quiet-output guidance never declares a task failed', () => {
  const run={state:'running',usage:{durationMs:3000},executions:[{status:'completed',durationMs:3000},{status:'running',startedAt:new Date(1000).toISOString()}]};
  assert.equal(executionDuration(run,65000),67000);assert.match(runningMessage(run,65000),/仍在运行/);
  run.executions[1].status='failed';assert.equal(executionDuration(run,65000),3000);
  assert.equal(formatDuration(59999),'59 秒');assert.equal(formatDuration(60000),'1 分 0 秒');
  assert.equal(executionDuration({...run,executions:[{status:'running',startedAt:'invalid',durationMs:2000}]},65000),5000);
});
