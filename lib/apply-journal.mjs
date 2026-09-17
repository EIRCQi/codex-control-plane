import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {loadJson,saveJson,createCollectionWriter} from './storage.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const objectId=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || '');
export async function createApplyJournal(file) {
  const saved=await loadJson(file,[],value=>Array.isArray(value) && value.every(entry=>typeof entry?.runId==='string' && typeof entry.repository==='string' && objectId(entry.baseHead) && objectId(entry.expectedTree) && typeof entry.baseRef==='string' && /^[a-f0-9]{64}$/.test(entry.patchHash)));
  let entries=new Map(saved.map(entry=>[entry.runId,entry]));
  const update=createCollectionWriter({read:()=>entries,write:next=>saveJson(file,[...next.values()]),commit:next=>{entries=next;}});
  return {
    get:id=>entries.get(id),
    all:()=>[...entries.values()],
    matches:(entry,run)=>entry.repository===run.repository && entry.baseHead===run.baseHead && entry.baseRef===run.baseRef && entry.patchHash===hash(run.diff),
    async prepare(run,expectedTree){
      const entry={id:randomUUID(),runId:run.id,repository:run.repository,baseHead:run.baseHead,baseRef:run.baseRef,patchHash:hash(run.diff),expectedTree,approvedAt:new Date().toISOString()};
      await update(next=>{if(next.has(run.id))throw new Error('Previous apply needs recovery before continuing');next.set(run.id,entry);});
      return entry;
    },
    remove:id=>update(next=>next.delete(id)),
  };
}

// Build the approved result in a private index; never alter the user's index
// while calculating the recovery fingerprint.
export async function expectedApplyTree(run,{git,dataDir}) {
  const dir=await mkdtemp(path.join(dataDir,'apply-index-'));
  const options={env:{GIT_INDEX_FILE:path.join(dir,'index')}};
  try {
    await git(run.repository,['read-tree',run.baseHead],undefined,options);
    await git(run.repository,['apply','--cached','--whitespace=nowarn','-'],run.diff,options);
    return (await git(run.repository,['write-tree'],undefined,options)).trim();
  }finally{await rm(dir,{recursive:true,force:true});}
}

// Recovery observes Git only. An uncertain result never resets or reapplies files.
export async function inspectApplyResult(entry,{git}) {
  const head=(await git(entry.repository,['rev-parse','HEAD'])).trim();
  let ref='';
  try {ref=(await git(entry.repository,['symbolic-ref','-q','HEAD'])).trim();}
  catch(error){if(error.code!=='COMMAND_EXIT')throw error;}
  if(head!==entry.baseHead || ref!==entry.baseRef)return 'uncertain';
  const staged=await git(entry.repository,['diff','--cached','--no-ext-diff','--no-textconv','--ignore-submodules=none','--name-only',entry.expectedTree,'--']);
  const unstaged=await git(entry.repository,['diff','--no-ext-diff','--no-textconv','--ignore-submodules=none','--name-only','--']);
  if(!staged.trim() && !unstaged.trim())return 'applied';
  const status=await git(entry.repository,['status','--porcelain']);
  return status.trim() ? 'uncertain' : 'not_applied';
}
