import test from 'node:test';
import assert from 'node:assert/strict';
import { agentOutput } from '../public/run-output.js';

test('reports show completed agent messages and retain readable legacy output', () => {
  const raw = [
    {type:'item.started', item:{type:'agent_message', text:'Draft'}},
    {type:'item.completed', item:{type:'command_execution', text:'Command log'}},
    {type:'item.completed', item:{type:'agent_message', text:'Finding 1\nREADME.md:2'}},
    {type:'turn.completed', usage:{input_tokens:10}},
    {type:'item.completed', item:{type:'agent_message', text:'Next step'}},
  ].map((event) => JSON.stringify(event)).join('\n');
  assert.equal(agentOutput(raw), 'Finding 1\nREADME.md:2\n\nNext step');
  assert.equal(agentOutput('Older plain-text report\nwith details'), 'Older plain-text report\nwith details');
  assert.equal(agentOutput('unparsed\n{"broken"'), 'unparsed\n{"broken"');
});
