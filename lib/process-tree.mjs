import { spawn } from 'node:child_process';
import path from 'node:path';

// POSIX callers must spawn a new process group. Never signal the Runner's group.
export const ownedProcessOptions = {detached:process.platform !== 'win32', windowsHide:true};

export function manageProcessTree(child, {env=process.env, graceMs=3000}={}) {
  let stopping=null, closed=false, exited=false, result;
  let resolveClosed;
  const closure=new Promise(resolve=>{resolveClosed=resolve;});
  const groupAlive=()=>{
    if (!child.pid) return false;
    try {process.kill(-child.pid,0);return true;} catch(error){return error.code !== 'ESRCH';}
  };
  const signalGroup=signal=>{
    if (!child.pid) return;
    try {process.kill(-child.pid,signal);} catch(error){if(error.code !== 'ESRCH')child.kill(signal);}
  };
  function stop() {
    if (stopping) return stopping;
    stopping=(async()=>{
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (!closed && !exited) await new Promise(resolve=>{
          const killer=spawn(path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          const timer=setTimeout(()=>{killer.kill();child.kill();resolve();},2000);
          killer.once('error',()=>child.kill());
          killer.once('close',code=>{clearTimeout(timer);if(code && child.exitCode === null)child.kill();resolve();});
        });
      } else {
        signalGroup('SIGTERM');
        const deadline=Date.now()+graceMs;
        while(groupAlive() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
        // The leader may have exited while a tool still owns the output pipes,
        // or while a tool with ignored stdio is continuing to modify files.
        if(groupAlive())signalGroup('SIGKILL');
      }
      if(!closed) await new Promise(resolve=>{
        const timer=setTimeout(()=>{child.stdout?.destroy();child.stderr?.destroy();child.stdin?.destroy();resolve();},200);
        closure.then(()=>{clearTimeout(timer);resolve();});
      });
    })();
    return stopping;
  }
  child.once('exit',()=>{exited=true;void stop();});
  child.once('close',(code,signal)=>{closed=true;result={code,signal};resolveClosed();});
  return {
    stop,
    async wait(){await closure;await stop();return result;},
  };
}
