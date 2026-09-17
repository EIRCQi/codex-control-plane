import { spawn } from 'node:child_process';
import path from 'node:path';
import {manageProcessTree,ownedProcessOptions} from './process-tree.mjs';

export function createCommandRunner({env=process.env, timeoutMs=120000, maxOutputBytes=16*1024*1024, maxErrorBytes=65536, killDelayMs=3000}={}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Git timeout must be a positive integer in milliseconds');
  const active = new Set();
  let closing = false;
  function run(executable,args,{cwd,input,signal,env:overrides}={}) {
    if (closing || signal?.aborted) return Promise.reject(Object.assign(new Error('Git command cancelled'),{code:'COMMAND_ABORTED'}));
    let stop;
    const promise = new Promise((resolve,reject) => {
      let child;
      const childEnv={...env,...overrides};
      try {child=spawn(executable,args,{cwd,env:childEnv,...ownedProcessOptions,stdio:[input === undefined ? 'ignore' : 'pipe','pipe','pipe']});}
      catch(error){reject(error); return;}
      const tree=manageProcessTree(child,{env:childEnv,graceMs:killDelayMs});
      const output=[];
      let bytes=0, stderr=Buffer.alloc(0), failure=null;
      const fail=(message,code) => {
        if (!failure) failure=Object.assign(new Error(message),{code});
        void tree.stop();
      };
      stop=()=>fail('Git command cancelled','COMMAND_ABORTED');
      const timer=setTimeout(()=>fail(`Git command timed out after ${timeoutMs} ms; inspect the repository before retrying`,'COMMAND_TIMEOUT'),timeoutMs);
      child.stdout.on('data',chunk=>{
        if (failure) return;
        bytes+=chunk.length;
        if (bytes > maxOutputBytes) {output.length=0; fail(`Git output exceeded ${maxOutputBytes} bytes; no partial result was accepted`,'COMMAND_OUTPUT_LIMIT');}
        else output.push(chunk);
      });
      child.stderr.on('data',chunk=>{stderr=Buffer.concat([stderr,chunk]).subarray(-maxErrorBytes);});
      child.once('error',error=>{failure ||= error;});
      void tree.wait().then(({code})=>{
        clearTimeout(timer);signal?.removeEventListener('abort',stop);
        if (failure) reject(failure);
        else if (code !== 0) reject(Object.assign(new Error(stderr.toString('utf8').trim() || `${path.basename(executable)} exited with code ${code}`),{code:'COMMAND_EXIT',exitCode:code}));
        else resolve(Buffer.concat(output,bytes).toString('utf8'));
      });
      signal?.addEventListener('abort',stop,{once:true});
      if (signal?.aborted) stop();
      if (input !== undefined) {
        child.stdin.on('error',error=>fail(`Git input failed: ${error.code || 'write error'}`,'COMMAND_INPUT'));
        child.stdin.end(input);
      }
    });
    const entry={promise,stop:()=>stop?.()};active.add(entry);
    const done=()=>active.delete(entry);promise.then(done,done);
    return promise;
  }
  return {
    run,
    get size(){return active.size;},
    async shutdown(){closing=true;for(const entry of active)entry.stop();await Promise.allSettled([...active].map(entry=>entry.promise));},
  };
}
