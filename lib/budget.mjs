export const defaultSettings = { maxConcurrentRuns: 2, maxTokensPerRun: 200000, maxTokensPerRepository: 1000000 };

export function validateSettings(value) {
  const next = {};
  for (const key of Object.keys(defaultSettings)) {
    const input = value?.[key];
    next[key] = typeof input === 'number' || (typeof input === 'string' && /^\d+$/.test(input)) ? Number(input) : NaN;
  }
  if (!Number.isSafeInteger(next.maxConcurrentRuns) || next.maxConcurrentRuns < 1 || next.maxConcurrentRuns > 8) throw new Error('Concurrent runs must be between 1 and 8');
  if (![next.maxTokensPerRun, next.maxTokensPerRepository].every(limit => Number.isSafeInteger(limit) && limit >= 0)) throw new Error('Token limits must be non-negative integers');
  return next;
}

export function budgetReason(run, settings, repositoryTotal) {
  const used = run.usage?.totalTokens || 0;
  if (settings.maxTokensPerRun > 0 && used >= settings.maxTokensPerRun) return `Run token budget exceeded (${used.toLocaleString()} / ${settings.maxTokensPerRun.toLocaleString()})`;
  if (settings.maxTokensPerRepository > 0 && repositoryTotal >= settings.maxTokensPerRepository) return `Repository token quota exceeded (${repositoryTotal.toLocaleString()} / ${settings.maxTokensPerRepository.toLocaleString()})`;
  return null;
}
