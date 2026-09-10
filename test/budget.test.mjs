import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateSettings, budgetReason } from '../lib/budget.mjs';

test('settings reject empty, boolean, fractional and unsafe limits without mutating defaults', () => {
  for (const value of [null, '', true, -1, 0.5, Number.MAX_SAFE_INTEGER+1, Infinity]) {
    assert.throws(()=>validateSettings({...defaultSettings,maxTokensPerRun:value}),/non-negative integers/);
  }
  for (const value of [null, '', true, 0, 9, 1.1]) assert.throws(()=>validateSettings({...defaultSettings,maxConcurrentRuns:value}),/between 1 and 8/);
  assert.equal(validateSettings({...defaultSettings,maxTokensPerRun:'123'}).maxTokensPerRun,123);
  assert.equal(defaultSettings.maxTokensPerRun,200000);
});

test('a fully consumed budget blocks another phase or retry; zero still means unlimited', () => {
  const settings={...defaultSettings,maxTokensPerRun:20,maxTokensPerRepository:100};
  assert.equal(budgetReason({usage:{totalTokens:19}},settings,99),null);
  assert.match(budgetReason({usage:{totalTokens:20}},settings,99),/Run token budget/);
  assert.match(budgetReason({usage:{totalTokens:19}},settings,100),/Repository token quota/);
  assert.equal(budgetReason({usage:{totalTokens:1000}},{...settings,maxTokensPerRun:0,maxTokensPerRepository:0},1000),null);
});
