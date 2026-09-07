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
