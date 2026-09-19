import {loadJson,saveJson,createSnapshotWriter} from './storage.mjs';
import {emptyUsage} from './usage.mjs';

const fields=['inputTokens','cachedInputTokens','outputTokens','totalTokens','durationMs'];
export async function createUsageLedger(file,{write=saveJson}={}) {
  const saved=await loadJson(file,null,value=>value?.version===1 && Array.isArray(value.entries) && value.entries.every(entry=>typeof entry?.id==='string' && typeof entry.repository==='string' && fields.every(key=>Number.isFinite(entry.usage?.[key]) && entry.usage[key]>=0)));
  const entries=new Map((saved?.entries || []).map(entry=>[entry.id,entry]));
  const repositoryTotals=new Map(),models=new Map(),modelRuns=new Map();
  const totals={...emptyUsage(),runs:entries.size};
  function adjustModel(usage,direction) {
    if(!usage?.model)return;
    const name=usage.model,count=(modelRuns.get(name)||0)+direction;
    if(!count){modelRuns.delete(name);models.delete(name);return;}
    modelRuns.set(name,count);models.set(name,(models.get(name)||0)+direction*usage.totalTokens);
  }
  for(const entry of entries.values()) {
    repositoryTotals.set(entry.repository,(repositoryTotals.get(entry.repository)||0)+entry.usage.totalTokens);
    for(const key of fields)totals[key]+=entry.usage[key];
    adjustModel(entry.usage,1);
  }
  let revision=0,savedRevision=saved ? 0 : -1;
  const writer=createSnapshotWriter(
    ()=>revision<=savedRevision ? null : {revision,value:{version:1,entries:[...entries.values()]}},
    async snapshot=>{
      if(!snapshot)return;
      await write(file,snapshot.value);
      savedRevision=snapshot.revision;
    },
  );
  function observe(run) {
    const previous=entries.get(run.id);
    if(previous && previous.repository!==run.repository)throw new Error('Usage ledger repository mismatch');
    const usage={...emptyUsage(),...previous?.usage};
    for(const key of fields)usage[key]=Math.max(usage[key],Number.isFinite(run.usage?.[key])?Math.max(0,run.usage[key]):0);
    usage.model=run.usage?.model || usage.model;
    if(!previous || fields.some(key=>usage[key]!==previous.usage[key]) || usage.model!==previous.usage.model) {
      repositoryTotals.set(run.repository,(repositoryTotals.get(run.repository)||0)+usage.totalTokens-(previous?.usage.totalTokens||0));
      for(const key of fields)totals[key]+=usage[key]-(previous?.usage[key]||0);
      if(!previous)totals.runs++;
      adjustModel(previous?.usage,-1);adjustModel(usage,1);
      entries.set(run.id,{id:run.id,repository:run.repository,usage});revision++;
    }
  }
  return {
    observe,
    observeAll(runs){for(const run of runs)observe(run);},
    // Recover after ledger-first persistence, before any per-task budget check.
    // Call after execution checkpoint recovery so elapsed time is not added twice.
    restore(run){
      const previous=entries.get(run.id);
      if(!previous)return false;
      if(previous.repository!==run.repository)throw new Error('Usage ledger repository mismatch');
      const current={...emptyUsage(),...run.usage};
      const usage={...current};
      for(const key of fields)usage[key]=Math.max(previous.usage[key],Number.isFinite(current[key])?current[key]:0);
      // Ledger writes precede task snapshots, including model-only updates.
      usage.model=previous.usage.model || usage.model;
      const changed=fields.some(key=>usage[key]!==current[key]) || usage.model!==current.model;
      if(changed)run.usage=usage;
      return changed;
    },
    get revision(){return revision;},
    flush:()=>revision<=savedRevision ? Promise.resolve() : writer.flush(),
    repositoryTokens:repository=>repositoryTotals.get(repository)||0,
    summary(runs){
      const ids=new Set(runs.map(run=>run.id));let live=0;
      for(const id of ids)if(entries.has(id))live++;
      return {...totals,models:Object.fromEntries(models),revision,retainedRuns:entries.size-live};
    },
  };
}
