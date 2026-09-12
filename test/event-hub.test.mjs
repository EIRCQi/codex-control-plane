import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventHub } from '../lib/event-hub.mjs';
class Response extends EventEmitter {
  frames=[];blocked=false;destroyed=false;writableEnded=false;
  write(frame){this.frames.push(frame);return !this.blocked;}
  end(){this.writableEnded=true;this.emit('finish');this.emit('close');}
  destroy(){this.destroyed=true;this.emit('close');}
  drain(){this.blocked=false;this.emit('drain');}
}
test('slow consumers coalesce run updates while fast consumers keep receiving events', () => {
  const hub=createEventHub();const slow=new Response(),fast=new Response();
  const client=hub.attach(slow);hub.attach(fast);slow.blocked=true;client.send('snapshot',[]);
  for(let i=0;i<100;i++)hub.broadcast('run',{id:'one',revision:i});
  assert.equal(slow.frames.length,1);assert.equal(fast.frames.length,100);
  slow.drain();assert.equal(slow.frames.length,2);assert.match(slow.frames[1],/"revision":99/);hub.close();assert.equal(hub.size,0);
});
test('snapshots supersede stale queued runs and large histories can drain before small messages', () => {
  const hub=createEventHub({maxPendingBytes:1024});const response=new Response();const client=hub.attach(response);
  response.blocked=true;client.send('session',{runnerId:'one'});client.send('run',{id:'deleted',revision:1});
  client.send('snapshot',[{id:'kept',output:'x'.repeat(20000)}]);client.send('auth',{state:'signed_in'});
  assert.equal(response.destroyed,false);response.drain();assert.equal(response.frames.length,3);assert.doesNotMatch(response.frames.join(''),/deleted/);assert.match(response.frames[2],/signed_in/);hub.close();
});
test('overflowing or stalled clients disconnect without harming other connections', async () => {
  const hub=createEventHub({maxPendingBytes:32,drainTimeoutMs:15});const bad=new Response(),good=new Response();
  const client=hub.attach(bad);hub.attach(good);bad.blocked=true;client.send('snapshot',[]);
  client.send('run',{id:'a',output:'x'.repeat(1000)});client.send('run',{id:'b',output:'x'.repeat(1000)});
  assert.equal(bad.destroyed,true);assert.equal(good.destroyed,false);assert.equal(hub.size,1);
  good.blocked=true;hub.broadcast('auth',{});await delay(40);assert.equal(good.destroyed,true);assert.equal(hub.size,0);
});
test('connection caps reject only new clients; no subscribers means no serialization', () => {
  const hub=createEventHub({maxClients:1});
  hub.broadcast('snapshot',{toJSON(){throw new Error('Should not serialize');}});
  const first=new Response();assert.ok(hub.attach(first));assert.equal(hub.attach(new Response()),null);first.destroy();assert.ok(hub.attach(new Response()));hub.close();
});
test('normal shutdown ends healthy event responses cleanly instead of resetting their sockets', async () => {
  const hub=createEventHub(),response=new Response();hub.attach(response).send('snapshot',[]);
  await hub.close();assert.equal(response.writableEnded,true);assert.equal(response.destroyed,false);assert.equal(hub.attach(new Response()),null);
});
