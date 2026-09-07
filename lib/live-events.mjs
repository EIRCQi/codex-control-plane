// Coalesce noisy log updates, but deliver every workflow transition immediately.
export function createRunPublisher(deliver, delayMs = 100) {
  const pending = new Map();
  const cancel = (id) => {
    const entry = pending.get(id);
    if (entry) { clearTimeout(entry.timer); pending.delete(id); }
  };
  return {
    schedule(run) {
      const entry = pending.get(run.id);
      if (entry) { entry.run = run; return; }
      const next = { run };
      next.timer = setTimeout(() => { pending.delete(run.id); deliver(next.run); }, delayMs);
      pending.set(run.id, next);
    },
    immediate(run) { cancel(run.id); deliver(run); },
    clear() { for (const id of pending.keys()) cancel(id); },
  };
}
