import { portStatus } from '../lib/port-status.mjs';

try {
  const result = await portStatus({port:Number(process.env.PORT || 4310)});
  console.log(result.text);
  if (!result.healthy) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
