import { addDuration } from './usage.mjs';

const reportLimit = 256 * 1024;
const diagnosticLimit = 32 * 1024;
export const executionLimit = 20;

export function beginExecution(run, now = Date.now()) {
  run.executions ||= [];
  if (!run.executions.length && run.output) {
    run.executions.push({seq:0, phase:'legacy', status:'legacy', output:run.output, legacy:true});
  }
  const entry = {seq:++run.executionSeq, phase:run.phase, status:'running', startedAt:new Date(now).toISOString(), checkpointAt:new Date(now).toISOString(), endedAt:null, durationMs:0, output:'', diagnostics:'', outputTruncated:false, diagnosticsTruncated:false, exitCode:null};
  run.executions.push(entry);
  run.executions = run.executions.slice(-executionLimit);
  run.output = '';
  return entry;
}

export function checkpointExecution(entry, now = Date.now()) {
  if (entry?.status !== 'running') return;
  entry.checkpointAt = new Date(now).toISOString();
  entry.durationMs = Math.max(0, now - Date.parse(entry.startedAt));
}

export function appendReport(run, entry, text) {
  if (!text || entry.outputTruncated) return;
  const joined = entry.output ? `${entry.output}\n\n${text}` : text;
  entry.outputTruncated = joined.length > reportLimit;
  entry.output = joined.slice(0, reportLimit).replace(/[\uD800-\uDBFF]$/, '');
  run.output = entry.output;
}

export function appendDiagnostic(entry, text) {
  const joined = entry.diagnostics + text;
  entry.diagnosticsTruncated ||= joined.length > diagnosticLimit;
  entry.diagnostics = joined.slice(-diagnosticLimit).replace(/^[\uDC00-\uDFFF]/, '');
}

export function finishExecution(run, entry, status, {now = Date.now(), exitCode = null, error = null} = {}) {
  if (entry.status !== 'running') return;
  checkpointExecution(entry, now);
  Object.assign(entry, {status, endedAt:new Date(now).toISOString(), exitCode, error});
  addDuration(run, entry.durationMs);
}

export function recoverExecutions(run) {
  run.executions ||= [];
  for (const entry of run.executions) {
    if (entry.status !== 'running') continue;
    // Count only time observed before the last save, never time spent offline.
    const now = Date.parse(entry.checkpointAt || entry.startedAt);
    finishExecution(run, entry, 'interrupted', {now:Number.isFinite(now) ? now : Date.now(), error:'Control plane restarted while this phase was running'});
  }
}

// Bound an unterminated or oversized CLI line without parsing a partial JSON
// object. Resume at the next newline so later usage/report events are retained.
export function createLineReader(onLine, {limit = 1024 * 1024, onOverflow = () => {}} = {}) {
  let buffer = '', dropping = false;
  function part(text, complete) {
    if (!dropping && buffer.length + text.length > limit) {
      buffer = ''; dropping = true; onOverflow();
    }
    if (!dropping) buffer += text;
    if (complete) {
      if (!dropping && buffer.trim()) onLine(buffer);
      buffer = ''; dropping = false;
    }
  }
  return {
    write(chunk) {
      let start = 0, end;
      while ((end = chunk.indexOf('\n', start)) !== -1) { part(chunk.slice(start, end), true); start = end + 1; }
      part(chunk.slice(start), false);
    },
    end() { part('', true); },
  };
}

export function parseCodexLine(line) {
  try {
    const event = JSON.parse(line);
    if (event && typeof event === 'object' && !Array.isArray(event)) return {event, plain:false};
  } catch { /* Plain-text output from older CLI versions remains readable. */ }
  return {event:{type:'output',message:line},plain:true};
}
