import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveConnection } from '../public/connection.js';

test('live connection requires a snapshot, reconnects stalled streams and ignores events from old connections', () => {
  const sources=[],states=[],runs=[],catalogs=[],settings=[];
  let clock=0,tick,cleared=false;
  class Source {
    handlers=new Map(); closed=false;
    constructor(url) { assert.equal(url,'/api/events'); sources.push(this); }
    addEventListener(type,fn) { this.handlers.set(type,fn); }
    emit(type,value) { this.handlers.get(type)?.({data:JSON.stringify(value)}); }
    close() { this.closed=true; }
  }
  const client=createLiveConnection({Source,now:()=>clock,schedule:fn=>{tick=fn;return 1;},unschedule:()=>cleared=true,
    onStatus:state=>states.push(state),onSnapshot:()=>{},onRun:run=>runs.push(run),onCatalog:value=>catalogs.push(value),onSettings:value=>settings.push(value)});
  const first=sources[0];
  first.emit('heartbeat',{});assert.deepEqual(states,[]);
  first.emit('snapshot',[]);assert.deepEqual(states,[true]);
  clock=30000;first.emit('heartbeat',{});tick();assert.equal(sources.length,1);
  clock=75000;tick();assert.equal(sources.length,2);assert.equal(first.closed,true);assert.deepEqual(states,[true,false]);
  first.emit('run',{id:'stale'});first.emit('snapshot',[]);assert.equal(runs.length,0);
  const second=sources[1];second.emit('snapshot',[]);second.emit('run',{id:'fresh'});
  second.emit('catalog',{projects:[]});second.emit('settings',{maxConcurrentRuns:1});
  assert.deepEqual(runs,[{id:'fresh'}]);assert.equal(catalogs.length,1);assert.equal(settings.length,1);
  client.close();assert.equal(second.closed,true);assert.equal(cleared,true);
  second.emit('run',{id:'after-close'});assert.equal(runs.length,1);
  client.reconnect();assert.equal(sources.length,3);
});
