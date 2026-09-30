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

test('invalid token counters cannot reduce recorded usage or coerce objects and booleans into tokens', () => {
  for(const value of [-30, '-30', 1.5, '1.5', NaN, Infinity, true, {}, [30]]){
    const run={usage:emptyUsage(),usageSeen:[]};
    recordUsage(run,{id:'first',usage:{input_tokens:40}},1);
    assert.equal(recordUsage(run,{id:'invalid',usage:{input_tokens:value,cached_input_tokens:value,output_tokens:value,total_tokens:value}},1),false);
    assert.equal(run.usageSeen.length,1,'invalid output must not displace valid deduplication records');
    assert.deepEqual(run.usage,{...emptyUsage(),inputTokens:40,totalTokens:40},`invalid counter: ${String(value)}`);
    recordUsage(run,{id:'next',usage:{input_tokens:20}},1);
    assert.equal(run.usage.totalTokens,60);
  }
});

test('token totals cannot undercount valid components and cached input cannot exceed all input', () => {
  const run={usage:emptyUsage(),usageSeen:[]};
  recordUsage(run,{id:'inconsistent',usage:{input_tokens:30,cached_input_tokens:100,output_tokens:10,total_tokens:1}},1);
  assert.deepEqual(run.usage,{...emptyUsage(),inputTokens:30,cachedInputTokens:30,outputTokens:10,totalTokens:40});
  recordUsage(run,{id:'alternate',usage:{prompt_tokens:'12',completion_tokens:'3',prompt_tokens_details:{cached_tokens:'4'},totalTokens:'20'}},1);
  assert.deepEqual(run.usage,{...emptyUsage(),inputTokens:42,cachedInputTokens:34,outputTokens:13,totalTokens:60});
});

test('token accumulation bounds new counters without reducing previously recorded usage', () => {
  const run={usage:emptyUsage(),usageSeen:[]},limit=Number.MAX_SAFE_INTEGER;
  recordUsage(run,{id:'large',usage:{input_tokens:limit,output_tokens:limit}},1);
  recordUsage(run,{id:'more',usage:{input_tokens:1,output_tokens:1}},1);
  for(const field of ['inputTokens','outputTokens','totalTokens']){
    assert.equal(run.usage[field],limit);
    assert.equal(Number.isSafeInteger(run.usage[field]),true);
  }
  for(const previous of [40.5,limit*2]){
    const legacy={usage:{...emptyUsage(),inputTokens:previous,totalTokens:previous},usageSeen:[]};
    recordUsage(legacy,{id:'continued',usage:{input_tokens:20}},2);
    assert.equal(legacy.usage.inputTokens,previous>limit?previous:previous+20);
    assert.equal(legacy.usage.totalTokens,legacy.usage.inputTokens);
  }
});
