import { spawn } from 'node:child_process';
import path from 'node:path';

export function createCommandRunner({env=process.env, timeoutMs=120000, maxOutputBytes=16*1024*1024, maxErrorBytes=65536, killDelayMs=3000}={}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Git timeout must be a positive integer in milliseconds');
  const active = new Set();
  let closing = false;
  function run(executable,args,{cwd,input,signal}={}) {
    if (closing || signal?.aborted) return Promise.reject(Object.assign(new Error('Git command cancelled'),{code:'COMMAND_ABORTED'}));
    let stop;
    const promise = new Promise((resolve,reject) => {
      let child;
      try {child=spawn(executable,args,{cwd,env,windowsHide:true,detached:process.platform !== 'win32',stdio:[input === undefined ? 'ignore' : 'pipe','pipe','pipe']});}
      catch(error){reject(error); return;}
      const output=[];
      let bytes=0, stderr=Buffer.alloc(0), failure=null, killTimer=null, treeStop=null;
      const signalChild=signal=>{
        if (!child.pid) return;
        if (process.platform !== 'win32') {
          try {process.kill(-child.pid,signal);} catch(error){if(error.code !== 'ESRCH')child.kill(signal);}
        } else if (!treeStop) {
          treeStop=new Promise(done=>{
            const killer=spawn(path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
            const deadline=setTimeout(()=>killer.kill(),2000);
            killer.once('error',()=>{child.kill();});
            killer.once('close',()=>{clearTimeout(deadline);done();});
          });
        } else child.kill(signal);
      };
      const fail=(message,code) => {
        if (!failure) failure=Object.assign(new Error(message),{code});
        if (killTimer) return;
        signalChild('SIGTERM');
        killTimer=setTimeout(()=>{signalChild('SIGKILL');child.stdout.destroy();child.stderr.destroy();},killDelayMs);
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
      child.once('close',async code=>{
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort',stop);
        if (treeStop) await treeStop;
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
