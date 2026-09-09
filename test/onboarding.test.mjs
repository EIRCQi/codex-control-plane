import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setupOnboarding } from '../public/onboarding.js';

// Exercise controller events with an element adapter, not browser layout or native focus.
function harness(t, request) {
  class Control {
    hidden = false; disabled = false; dataset = {}; textContent = ''; handlers = new Map();
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    click() { this.handlers.get('click')?.(); }
    removeAttribute(name) { delete this[name]; }
  }
  const nodes = new Map(), notifications = [], busy = [], navigation = [];
  const get = key => { if (!nodes.has(key)) nodes.set(key, new Control()); return nodes.get(key); };
  const previous = {document:global.document, window:global.window};
  global.document = {querySelector:get}; global.window = new Control();
  t.after(() => { global.document = previous.document; global.window = previous.window; });
  const ui = setupOnboarding({request, notify:message => notifications.push(message), onEnvironment:() => navigation.push('environment'), onProject:() => navigation.push('project'), onTask:() => navigation.push('task'), onSignedIn:() => navigation.push('signed-in'), onBusyChange:value => busy.push(value)});
  return {ui, get, notifications, busy, navigation};
}
const state = (revision, state = 'signed_out', busy = false, extra = {}) => ({instanceId:'runner-a', revision, state, busy, ...extra});
const response = value => ({json:async () => value});
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  throw new Error('Onboarding fixture did not settle');
}

test('login controls block duplicates, keep newer streamed state and clear fallback links on success', async t => {
  let resolveLogin, starts = 0;
  const h = harness(t, path => {
    if (path.endsWith('refresh')) return Promise.resolve(response(state(1)));
    starts++; return new Promise(resolve => { resolveLogin = resolve; });
  });
  h.ui.connectionChanged(true); await until(() => !h.get('#refresh-login').disabled);
  h.get('#login-codex').click(); h.get('#login-codex').click();
  assert.equal(starts, 1); assert.equal(h.get('#login-codex').disabled, true);
  h.ui.accept(state(3, 'waiting', true, {loginUrl:'https://auth.openai.com/oauth/authorize?fixture'}));
  assert.equal(h.get('#login-link').hidden, false); assert.equal(h.get('#setup-project').disabled, true);
  resolveLogin(response(state(2, 'starting', true)));
  await until(() => !h.get('#cancel-login').disabled);
  assert.equal(h.get('#login-status').textContent, 'Waiting for browser');
  h.ui.accept(state(4, 'signed_in'));
  assert.equal(h.get('#login-link').hidden, true); assert.equal(h.get('#login-link').href, undefined);
  assert.equal(h.get('#login-codex').hidden, true); assert.equal(h.busy.at(-1), false);
  assert.deepEqual(h.notifications, ['Codex login is ready']);
  h.get('#setup-project').click(); h.ui.projectsChanged([{id:'project'}]); h.get('#setup-project').click();
  assert.deepEqual(h.navigation, ['signed-in', 'project', 'task']);
});

test('reconnecting during a slow check schedules a fresh check and ignores the old HTTP reply', async t => {
  const requests = [];
  const h = harness(t, () => new Promise(resolve => requests.push(resolve)));
  h.ui.connectionChanged(true); assert.equal(requests.length, 1);
  h.ui.connectionChanged(false); h.ui.connectionChanged(true);
  h.ui.accept({...state(0, 'unknown'), instanceId:'runner-b'});
  requests[0](response(state(99, 'signed_in')));
  await until(() => requests.length === 2);
  assert.equal(h.get('#login-status').textContent, 'Login not checked');
  requests[1](response({...state(2), instanceId:'runner-b'}));
  await until(() => !h.get('#refresh-login').disabled);
  assert.equal(h.get('#login-status').textContent, 'Sign in required');
});

test('failed login requests release controls for retry and disconnection hides browser links', async t => {
  const h = harness(t, async path => { if (path.endsWith('login')) throw new Error('Finish active tasks first'); return response(state(1)); });
  h.ui.connectionChanged(true); await until(() => !h.get('#refresh-login').disabled);
  h.get('#login-codex').click(); await until(() => h.get('#login-error').textContent);
  assert.equal(h.get('#login-error').textContent, 'Finish active tasks first'); assert.equal(h.get('#login-codex').disabled, false);
  h.ui.accept(state(2, 'waiting', true, {loginUrl:'https://auth.openai.com/oauth/authorize?fixture'}));
  h.ui.connectionChanged(false);
  assert.equal(h.get('#login-link').hidden, true); assert.equal(h.get('#cancel-login').disabled, true);
});
