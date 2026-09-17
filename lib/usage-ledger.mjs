import {loadJson,saveJson,createSnapshotWriter} from './storage.mjs';
import {emptyUsage,aggregateUsage} from './usage.mjs';

const fields=['inputTokens','cachedInputTokens','outputTokens','totalTokens','durationMs'];
export async function createUsageLedger(file) {
  const saved=await loadJson(file,{version:1,entries:[]},value=>value?.version===1 && Array.isArray(value.entries) && value.entries.every(entry=>typeof entry?.id==='string' && typeof entry.repository==='string' && fields.every(key=>Number.isFinite(entry.usage?.[key]) && entry.usage[key]>=0)));
  const entries=new Map(saved.entries.map(entry=>[entry.id,entry]));
  const repositoryTotals=new Map();
  for(const entry of entries.values())repositoryTotals.set(entry.repository,(repositoryTotals.get(entry.repository)||0)+entry.usage.totalTokens);
  let revision=0;
  const writer=createSnapshotWriter(()=>({version:1,entries:[...entries.values()]}),value=>saveJson(file,value));
  function observe(run) {
    const previous=entries.get(run.id);
    if(previous && previous.repository!==run.repository)throw new Error('Usage ledger repository mismatch');
    const usage={...emptyUsage(),...previous?.usage};
    for(const key of fields)usage[key]=Math.max(usage[key],Number.isFinite(run.usage?.[key])?Math.max(0,run.usage[key]):0);
    usage.model=run.usage?.model || usage.model;
    if(!previous || JSON.stringify(usage)!==JSON.stringify(previous.usage)) {
      repositoryTotals.set(run.repository,(repositoryTotals.get(run.repository)||0)+usage.totalTokens-(previous?.usage.totalTokens||0));
      entries.set(run.id,{id:run.id,repository:run.repository,usage});revision++;
    }
  }
  return {
    observe,
    observeAll(runs){for(const run of runs)observe(run);},
    flush:()=>writer.flush(),
    repositoryTokens:repository=>repositoryTotals.get(repository)||0,
    summary(runs){const ids=new Set(runs.map(run=>run.id));return {...aggregateUsage([...entries.values()]),revision,retainedRuns:[...entries.keys()].filter(id=>!ids.has(id)).length};},
  };
}
