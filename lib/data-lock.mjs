import {mkdir,realpath,open,link,readFile,unlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code !== 'ESRCH';}};
const valid=owner=>owner && Number.isSafeInteger(owner.pid) && owner.pid>0 && /^[a-f0-9-]{36}$/.test(owner.token) && typeof owner.host==='string';

export async function acquireDataLock(directory) {
  await mkdir(directory,{recursive:true});
  const canonical=await realpath(directory),file=path.join(canonical,'runner.lock');
  const owner={pid:process.pid,host:os.hostname(),token:randomUUID()};
  const candidate=path.join(canonical,`runner-${owner.token}.tmp`);
  const handle=await open(candidate,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(owner));await handle.sync();}finally{await handle.close();}
  const busy=()=>Object.assign(new Error('Data directory is already in use or its lock cannot be verified; stop the existing Runner before restarting'),{code:'DATA_DIR_LOCKED'});
  try {
    let acquired=false;
    for(let attempt=0;attempt<5;attempt++) {
      try {await link(candidate,file);acquired=true;break;}
      catch(error){if(error.code!=='EEXIST')throw error;}
      let previous;
      try {previous=JSON.parse(await readFile(file,'utf8'));}
      catch(error){if(error.code==='ENOENT')continue;throw busy();}
      if(!valid(previous) || previous.host!==owner.host || alive(previous.pid))throw busy();
      // Each old owner has its own exclusive recovery guard. Contenders cannot
      // remove a newer owner's lock after another contender has recovered it.
      const guard=path.join(canonical,`runner-reclaim-${previous.token}`);
      try {await mkdir(guard);}
      catch(error){if(error.code==='EEXIST')throw busy();throw error;}
      try {
        const current=JSON.parse(await readFile(file,'utf8'));
        if(current.token===previous.token && !alive(current.pid))await unlink(file);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      finally{await rm(guard,{recursive:true,force:true});}
      if(attempt===4)throw busy();
    }
    if(!acquired)throw busy();
    return async()=>{
      try {const current=JSON.parse(await readFile(file,'utf8'));if(current.token===owner.token)await unlink(file);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    };
  }finally{await rm(candidate,{force:true});}
}
