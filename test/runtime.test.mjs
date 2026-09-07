import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { diagnose, probe, resolveTool, runtimeEnvironment, validateRuntimeSettings } from '../lib/runtime.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccp-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('executable resolution respects overrides and rejects invalid or missing paths', async () => {
  const settings = validateRuntimeSettings({ codexPath: ` ${process.execPath} ` });
  assert.equal(await resolveTool('codex', settings, { PATH: '' }), process.execPath);
  assert.equal(await resolveTool('codex', {codexPath: '/missing'}, { CODEX_CONTROL_PLANE_CODEX_BIN: process.execPath }), process.execPath);
  await assert.rejects(resolveTool('codex', {codexPath: path.join(os.tmpdir(), 'ccp-missing-executable')}, process.env), /Cannot execute/);
  await assert.rejects(resolveTool('codex', {}, {PATH:''}), /not found/);
  await assert.rejects(resolveTool('codex', {}, {CODEX_CONTROL_PLANE_CODEX_BIN:'codex --flag'}), /absolute/);
  for (const value of [null, [], 'bad', {codexPath:'relative'}, {gitPath:123}, {gitPath:'\0'}]) {
    assert.throws(() => validateRuntimeSettings(value));
  }
  const env = runtimeEnvironment({ Path: `.${path.delimiter}${path.dirname(process.execPath)}` });
  assert.ok(env.Path.split(path.delimiter).every((directory) => path.isAbsolute(directory)));
  assert.equal(env.PATH, undefined);
});

test('diagnostic subprocesses bound output and time and report spawn failures', async () => {
  const result = await probe(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))']);
  assert.equal(result.ok, true); assert.equal(result.output.length, 8192);
  const timeout = await probe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {timeoutMs:100});
  assert.equal(timeout.reason, 'TIMEOUT'); assert.equal(timeout.ok, false);
  const missing = await probe(path.join(os.tmpdir(), 'ccp-no-such-program'), []);
  assert.equal(missing.reason, 'ENOENT');
});

test('diagnostics explain missing tools and unwritable data targets without creating files', async (t) => {
  const directory = await temporary(t);
  const dataFile = path.join(directory, 'file');
  await writeFile(dataFile, 'not a directory');
  const report = await diagnose({env:{PATH:''}, dataDir:dataFile});
  assert.equal(report.ready, false);
  assert.equal(report.git.status, 'missing'); assert.equal(report.codex.status, 'missing');
  assert.equal(report.authentication.status, 'unknown'); assert.equal(report.storage.status, 'error');
});

test('diagnostics redact auth output and distinguish successful credentials, logout and failed versions', {skip:process.platform === 'win32'}, async (t) => {
  const directory = await temporary(t);
  const executable = path.join(directory, 'codex with spaces');
  const secret = 'credential-marker-must-not-leave-probe';
  await writeFile(executable, `#!${process.execPath}
if (process.argv.includes('--version')) {
  console.log('codex-cli 1.2.3'); process.exit(process.env.FAIL_VERSION ? 1 : 0);
}
console.error('${secret}'); process.exit(process.env.LOGGED_OUT ? 1 : 0);
`, {mode:0o755});
  const options = {settings:{gitPath:process.execPath, codexPath:executable}, env:runtimeEnvironment(), dataDir:path.join(directory, 'future-data'), version:'0.2.0'};
  const report = await diagnose(options);
  assert.equal(report.ready, true); assert.equal(report.codex.version, '1.2.3');
  assert.match(report.storage.hint, /will be created/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  const logout = await diagnose({...options, env:{...options.env, LOGGED_OUT:'1'}});
  assert.equal(logout.ready, false); assert.equal(logout.authentication.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(logout), new RegExp(secret));
  const failed = await diagnose({...options, env:{...options.env, FAIL_VERSION:'1'}});
  assert.equal(failed.codex.status, 'error'); assert.equal(failed.authentication.status, 'unknown');
});
