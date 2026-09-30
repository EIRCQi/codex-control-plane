import { readFile, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Serialize snapshots per file; a failed write must not poison subsequent saves.
const pending = new Map();
export function saveJson(file, value) {
  const snapshot = JSON.stringify(value, null, 2);
  const job = (pending.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(snapshot); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  });
  pending.set(file, job);
  const clear = () => { if (pending.get(file) === job) pending.delete(file); };
  job.then(clear, clear);
  return job;
}

export async function loadJson(file, fallback, valid = () => true) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!valid(value)) throw new Error('Invalid data structure');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}. Original file preserved.`, { cause: error });
  }
}

// Only the active snapshot and one follow-up batch exist, even on a slow disk.
// Requests arriving during a write wait for a fresh snapshot after that write.
// Optional transactions prepare the detached snapshot, then commit live state
// synchronously after its write succeeds and before capturing the next batch.
// Commit callbacks must not throw or perform asynchronous work.
export function createSnapshotWriter(capture, write) {
  let active = false, next = null;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes,no) => {resolve=yes; reject=no;});
    return {promise,resolve,reject,transactions:[]};
  };
  async function pump() {
    if (active) return;
    active = true;
    while (next) {
      const batch = next; next = null;
      try {
        const snapshot = capture();
        for (const transaction of batch.transactions) transaction.prepare(snapshot);
        await write(snapshot);
        for (const transaction of batch.transactions) transaction.commit();
        batch.resolve();
      }
      catch (error) {batch.reject(error);}
    }
    active = false;
  }
  return {
    flush(transaction) {
      if (!next) next = deferred();
      if (transaction) next.transactions.push(transaction);
      const promise = next.promise;
      queueMicrotask(pump);
      return promise;
    },
  };
}

// Serialize read/modify/write transactions and publish memory only after saving.
export function createCollectionWriter({read, write, commit}) {
  let pending = Promise.resolve();
  return change => {
    const job = pending.catch(() => {}).then(async () => {
      const next = structuredClone(read());
      const result = change(next);
      await write(next);
      commit(next);
      return result;
    });
    pending = job;
    return job;
  };
}
