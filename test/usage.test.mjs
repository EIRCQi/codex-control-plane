import test from "node:test";
import assert from "node:assert/strict";
import { addDuration, aggregateUsage, emptyUsage, recordUsage } from "../lib/usage.mjs";

test("extracts response usage and model", () => {
  const run = { usage: emptyUsage(), usageSeen: [] };
  const event = { type: "response.completed", response: { id: "r1", model: "gpt-test", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, total_tokens: 120 } } };
  assert.equal(recordUsage(run, event, 1), true);
  assert.deepEqual(run.usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120, durationMs: 0, model: "gpt-test" });
  assert.equal(recordUsage(run, event, 1), false);
});

test("supports alternate token field names and aggregates", () => {
  const first = { usage: emptyUsage(), usageSeen: [] };
  recordUsage(first, { type: "turn.completed", usage: { prompt_tokens: 12, completion_tokens: 3 } }, 1);
  addDuration(first, 1499.6);
  const total = aggregateUsage([first]);
  assert.equal(total.totalTokens, 15);
  assert.equal(total.durationMs, 1500);
  assert.equal(total.runs, 1);
});
