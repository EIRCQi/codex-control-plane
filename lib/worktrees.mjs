import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

const samePath = (left, right) => path.relative(left, right) === '';
const unline = value => value.replace(/\r?\n$/, '');

function worktreeRecords(output) {
  return output.split('\0\0').filter(Boolean).map(record => Object.fromEntries(
    record.split('\0').filter(Boolean).map(field => {
      const separator = field.indexOf(' ');
      return separator < 0 ? [field, true] : [field.slice(0, separator), field.slice(separator + 1)];
    }),
  ));
}

// Check both the filesystem location and Git's link back to this repository.
// A directory at the expected path alone is not proof that it is task-owned.
export async function inspectOwnedWorktree(run, {root, git, operation = 'reset', cleanup = false, allowMissing = false}) {
  const refuse = () => {throw new Error(`Worktree does not belong to this task; ${operation} was refused`);};
  if (typeof run.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(run.id)) refuse();
  const expected = path.resolve(root, run.id);
  const branch = `codex-control-plane/${run.id}`;
  if (typeof run.worktree !== 'string' || !path.isAbsolute(run.worktree) || !samePath(path.resolve(run.worktree), expected) || run.branch !== branch) refuse();
  const canonical = path.join(await realpath(root), run.id);
  let stats;
  try {stats = await lstat(expected);}
  catch (error) {if (error.code !== 'ENOENT' || !allowMissing) throw error;}
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(expected), canonical))) refuse();
  if (samePath(await realpath(run.repository), canonical)) refuse();

  const options = {run, cleanup};
  const records = worktreeRecords(await git(run.repository, ['worktree', 'list', '--porcelain', '-z'], undefined, options));
  const registered = records.find(record => typeof record.worktree === 'string' &&
    (samePath(path.resolve(record.worktree), expected) || samePath(path.resolve(record.worktree), canonical)));
  if (registered?.bare || (registered?.branch && registered.branch !== `refs/heads/${branch}`)) refuse();
  if (stats) {
    if (!registered) refuse();
    const gitFile = path.join(expected, '.git');
    const gitFileStats = await lstat(gitFile);
    if (!gitFileStats.isFile() || gitFileStats.isSymbolicLink()) refuse();
    const top = unline(await git(expected, ['rev-parse', '--show-toplevel'], undefined, options));
    if (!samePath(await realpath(top), canonical)) refuse();
    const common = unline(await git(run.repository, ['rev-parse', '--git-common-dir'], undefined, options));
    const commonDir = await realpath(path.resolve(run.repository, common));
    const admin = await realpath(unline(await git(expected, ['rev-parse', '--absolute-git-dir'], undefined, options)));
    if (!samePath(path.dirname(admin), path.join(commonDir, 'worktrees'))) refuse();
    const backlink = unline(await readFile(path.join(admin, 'gitdir'), 'utf8'));
    if (!samePath(await realpath(path.resolve(admin, backlink)), path.join(canonical, '.git'))) refuse();
  }
  return {expected, registered:Boolean(registered)};
}

export async function cleanupOwnedWorktree(run, {root, git}) {
  if (!run.worktree) return;
  const owned = await inspectOwnedWorktree(run, {root, git, operation:'cleanup', cleanup:true, allowMissing:true});
  const options = {run, cleanup:true};
  // Respect Git locks and errors. Never fall back to recursive filesystem removal.
  if (owned.registered) await git(run.repository, ['worktree', 'remove', '--force', '--', owned.expected], undefined, options);
  const ref = `refs/heads/${run.branch}`;
  const refs = await git(run.repository, ['for-each-ref', '--format=%(refname)', '--', ref], undefined, options);
  if (refs.split(/\r?\n/).includes(ref)) await git(run.repository, ['branch', '-D', '--', run.branch], undefined, options);
  // Keep this pointer on any failure, including a branch failure after removal.
  // A retry can finish cleanup even if the directory is already absent.
  run.worktree = null;
}
