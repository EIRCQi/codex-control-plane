export function captureView(root) {
  const active = root.ownerDocument.activeElement;
  return {
    top: root.scrollTop, left: root.scrollLeft,
    focus: root.contains(active) && active.matches('button[data-id]') ? { id: active.dataset.id, action: active.dataset.action, className: active.className } : null,
    sections: new Map([...root.querySelectorAll('[data-view]')].map((node) => [node.dataset.view, {
      open: node.tagName === 'DETAILS' ? node.open : undefined,
      top: node.scrollTop, left: node.scrollLeft,
      follow: node.dataset.follow === 'true' && node.scrollHeight - node.clientHeight - node.scrollTop < 8,
    }])),
  };
}

export function restoreView(root, state) {
  root.scrollTop = state.top; root.scrollLeft = state.left;
  for (const node of root.querySelectorAll('[data-view]')) {
    const previous = state.sections.get(node.dataset.view);
    if (!previous) continue;
    if (previous.open !== undefined) node.open = previous.open;
    node.scrollTop = previous.follow ? node.scrollHeight : previous.top;
    node.scrollLeft = previous.left;
  }
  if (state.focus) {
    const {id, action, className} = state.focus;
    [...root.querySelectorAll('button[data-id]')].find((button) => button.dataset.id === id && button.dataset.action === action && button.className === className)?.focus({preventScroll:true});
  }
}

// Keep unchanged cards in the DOM so another run's logs cannot collapse them.
export function createRunList(container, renderCard) {
  const cards = new Map();
  return (runs) => {
    const visible = new Set(runs.map((run) => run.id));
    for (const [id, entry] of cards) {
      if (!visible.has(id)) { entry.node.remove(); cards.delete(id); }
    }
    runs.forEach((run, index) => {
      let entry = cards.get(run.id);
      if (!entry || entry.run !== run) {
        const template = container.ownerDocument.createElement('template');
        template.innerHTML = renderCard(run);
        const node = template.content.firstElementChild;
        const previous = entry && captureView(entry.node);
        if (entry) entry.node.replaceWith(node);
        else container.insertBefore(node, container.children[index] || null);
        if (previous) restoreView(node, previous);
        entry = {run, node};
        cards.set(run.id, entry);
      }
      if (container.children[index] !== entry.node) container.insertBefore(entry.node, container.children[index] || null);
    });
  };
}
