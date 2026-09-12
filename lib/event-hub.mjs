const encode = (type, value) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;

export function createEventHub({maxClients=32, maxPendingBytes=2*1024*1024, drainTimeoutMs=10000, heartbeatMs=15000}={}) {
  const clients = new Set();
  let heartbeat = null, closing=false;
  function attach(response) {
    if (closing || clients.size >= maxClients) return null;
    let closed = false, blocked = false, timer = null, pendingBytes = 0;
    const pending = new Map();
    const remove = () => {
      if (closed) return;
      closed = true; clearTimeout(timer); pending.clear(); clients.delete(client);
      response.off('drain', drain); response.off('close', remove);
      if (!clients.size) {clearInterval(heartbeat); heartbeat=null;}
    };
    const disconnect = () => {remove(); response.destroy();};
    const write = frame => {
      if (closed || response.destroyed || response.writableEnded) {remove(); return;}
      try {
        if (!response.write(frame)) {
          blocked = true;
          timer = setTimeout(disconnect, drainTimeoutMs); timer.unref?.();
        }
      } catch {disconnect();}
    };
    const enqueue = (key, frame) => {
      if (closed) return;
      if (!blocked) {write(frame); return;}
      if (key === 'heartbeat') return;
      if (key === 'snapshot') {
        for (const [id,entry] of pending) if (id.startsWith('run:')) {pendingBytes-=entry.bytes; pending.delete(id);}
      }
      const bytes = Buffer.byteLength(frame);
      pendingBytes -= pending.get(key)?.bytes || 0;
      pending.set(key,{frame,bytes}); pendingBytes += bytes;
      // Permit one large snapshot/run plus the small-event allowance. This lets
      // large histories reconnect while preventing unbounded per-client queues.
      let largest=0;for(const entry of pending.values())largest=Math.max(largest,entry.bytes);
      if (pendingBytes > maxPendingBytes + largest) disconnect();
    };
    function drain() {
      clearTimeout(timer); timer=null; blocked=false;
      for (const [key,entry] of pending) {
        pending.delete(key); pendingBytes-=entry.bytes; write(entry.frame);
        if (blocked || closed) break;
      }
    }
    const client = {
      send(type,value) {enqueue(type === 'run' ? `run:${value.id}` : type,encode(type,value));},
      enqueue, close:disconnect,
      finish() {
        if (closed) return Promise.resolve();
        remove();
        return new Promise(resolve=>{
          const deadline=setTimeout(()=>{response.destroy();resolve();},Math.min(drainTimeoutMs,1000));
          const done=()=>{clearTimeout(deadline);resolve();};
          response.once('finish',done);response.once('close',done);
          try {response.end();} catch {disconnect();done();}
        });
      },
    };
    clients.add(client);
    response.on('drain',drain); response.once('close',remove); response.on('error',disconnect);
    if (!heartbeat) {
      heartbeat = setInterval(() => {for (const item of clients) item.enqueue('heartbeat','event: heartbeat\ndata: {}\n\n');},heartbeatMs);
      heartbeat.unref?.();
    }
    return client;
  }
  return {
    attach,
    get size() {return clients.size;},
    broadcast(type,value) {
      if (!clients.size) return;
      const frame=encode(type,value), key=type === 'run' ? `run:${value.id}` : type;
      for (const client of clients) client.enqueue(key,frame);
    },
    async close() {closing=true;await Promise.all([...clients].map(client=>client.finish()));},
  };
}
