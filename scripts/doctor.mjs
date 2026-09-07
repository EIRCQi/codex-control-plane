import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { diagnose, runtimeDefaults, validateRuntimeSettings } from '../lib/runtime.mjs';
import { loadJson } from '../lib/storage.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.CODEX_CONTROL_PLANE_DATA_DIR || path.join(root, '.codex-control-plane');
try {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const settings = validateRuntimeSettings(await loadJson(path.join(dataDir, 'runtime.json'), runtimeDefaults));
  const report = await diagnose({ settings, dataDir, version });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Codex Control Plane ${version} · Node ${report.node} · ${report.platform}/${report.arch}`);
    for (const key of ['git', 'codex', 'authentication', 'storage']) {
      const entry = report[key];
      console.log(`${entry.status.toUpperCase()}  ${key}: ${entry.version || ''} ${entry.command || entry.path || ''}`.trim());
      if (entry.hint) console.log(`  ${entry.hint}`);
    }
  }
  if (!report.ready) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
