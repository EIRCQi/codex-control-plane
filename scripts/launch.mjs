import { selectRunner, openDashboard } from '../lib/launcher.mjs';

try {
  const selected = await selectRunner({
    port:Number(process.env.PORT || 4310),
    start:async () => {
      const {serverReady, shutdown} = await import('../server.mjs');
      const ready = await serverReady;
      return {url:ready.url, shutdown};
    },
  });
  console.log(selected.reused ? `Opening the existing Runner (${selected.version}).` : 'Runner started. Keep this terminal open; Ctrl+C stops this Runner and its tasks.');
  if (!await openDashboard(selected.url)) console.log('Open this address in your browser:');
  console.log(selected.url);
} catch (error) {
  console.error(error.message);
  console.error('Run npm run status for a read-only health and listening-process report.');
  process.exitCode = 1;
}
