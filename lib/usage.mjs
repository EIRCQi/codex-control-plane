const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function findUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.usage && typeof value.usage === "object") return value.usage;
  for (const child of Object.values(value)) {
    const found = findUsage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findModel(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (typeof value.model === "string") return value.model;
  for (const child of Object.values(value)) {
    const found = findModel(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function emptyUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, model: null };
}

export function recordUsage(run, event, executionSeq = 0) {
  run.usage ||= emptyUsage();
  run.usageSeen ||= [];
  const model = findModel(event);
  if (model) run.usage.model = model;
  const usage = findUsage(event);
  if (!usage) return false;
  const normalized = {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    cachedInputTokens: number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    totalTokens: number(usage.total_tokens ?? usage.totalTokens),
  };
  if (!normalized.totalTokens) normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  const signature = `${executionSeq}:${event.id || event.response?.id || event.type || "usage"}:${JSON.stringify(normalized)}`;
  if (run.usageSeen.includes(signature)) return false;
  run.usageSeen.push(signature);
  if (run.usageSeen.length > 100) run.usageSeen.shift();
  run.usage.inputTokens += normalized.inputTokens;
  run.usage.cachedInputTokens += normalized.cachedInputTokens;
  run.usage.outputTokens += normalized.outputTokens;
  run.usage.totalTokens += normalized.totalTokens;
  return true;
}

export function addDuration(run, durationMs) {
  run.usage ||= emptyUsage();
  run.usage.durationMs += Math.max(0, Math.round(durationMs));
}

export function aggregateUsage(runs) {
  return runs.reduce((total, run) => {
    const usage = run.usage || emptyUsage();
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.durationMs += usage.durationMs;
    total.runs += 1;
    if (usage.model) total.models[usage.model] = (total.models[usage.model] || 0) + usage.totalTokens;
    return total;
  }, { ...emptyUsage(), runs: 0, models: {} });
}
