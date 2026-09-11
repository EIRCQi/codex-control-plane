import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from '../lib/workflow.mjs';
import { beginExecution, checkpointExecution, appendReport, appendDiagnostic, finishExecution, recoverExecutions, createLineReader, parseCodexLine } from '../lib/execution.mjs';

test('failed attempts retain partial output and diagnostics across retries; durations count once', () => {
  const run=createRun({id:'a',repository:'/repo',prompt:'task'});
  const first=beginExecution(run,1000);
  appendReport(run,first,'部分报告 中文');appendDiagnostic(first,'error details');
  finishExecution(run,first,'failed',{now:4000,exitCode:1});finishExecution(run,first,'failed',{now:9000});
  assert.equal(run.output,'部分报告 中文');assert.equal(run.usage.durationMs,3000);
  const second=beginExecution(run,10000);assert.equal(run.output,'');
  appendReport(run,second,'retry report');finishExecution(run,second,'completed',{now:12000});
  assert.equal(run.usage.durationMs,5000);assert.equal(run.executions[0].diagnostics,'error details');
  assert.equal(run.executions[0].output,'部分报告 中文');assert.equal(run.executions[1].output,'retry report');
});

test('restart recovery retains the last checkpoint without counting time offline', () => {
  const run=createRun({id:'a',repository:'/repo',prompt:'task'});
  const entry=beginExecution(run,1000);appendReport(run,entry,'saved report');checkpointExecution(entry,7000);
  const restored=JSON.parse(JSON.stringify(run));recoverExecutions(restored);recoverExecutions(restored);
  assert.equal(restored.executions[0].status,'interrupted');assert.equal(restored.usage.durationMs,6000);
  assert.equal(restored.executions[0].endedAt,new Date(7000).toISOString());assert.equal(restored.output,'saved report');
});

test('reports, diagnostics and attempt retention are bounded while aggregate usage is preserved', () => {
  const run=createRun({id:'a',repository:'/repo',prompt:'task'});run.output='legacy output';
  const entry=beginExecution(run,1000);assert.equal(run.executions[0].output,'legacy output');
  appendReport(run,entry,'x'.repeat(256*1024-1)+'😀more');assert.equal(entry.outputTruncated,true);
  assert.doesNotMatch(entry.output,/[\uD800-\uDBFF]$/);assert.ok(entry.output.length<=256*1024);
  appendDiagnostic(entry,'x'.repeat(40000)+'end');assert.equal(entry.diagnosticsTruncated,true);assert.equal(entry.diagnostics.length,32768);assert.ok(entry.diagnostics.endsWith('end'));
  finishExecution(run,entry,'completed',{now:2000});
  for(let i=0;i<25;i++){const next=beginExecution(run,3000+i*1000);finishExecution(run,next,'completed',{now:4000+i*1000});}
  assert.equal(run.executions.length,20);assert.equal(run.usage.durationMs,26000);
});

test('oversized or scalar events cannot break the line reader; later JSON and unterminated text survive', () => {
  const lines=[],overflows=[];const reader=createLineReader(line=>lines.push(line),{limit:20,onOverflow:()=>overflows.push(true)});
  reader.write('x'.repeat(25));reader.write('x'.repeat(25)+'\nnull\n{"type":"ok"}\ntail');reader.end();
  assert.equal(overflows.length,1);assert.deepEqual(lines,['null','{"type":"ok"}','tail']);
  for(const line of ['null','123','[]','plain text'])assert.equal(parseCodexLine(line).event.type,'output');
  assert.equal(parseCodexLine('{"type":"ok"}').event.type,'ok');
});
