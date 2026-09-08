export function notify(message, {kind = 'success', action} = {}) {
  const region = document.querySelector('dialog[open] .modal-feedback') || document.querySelector('#toast-region');
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span'); text.textContent = message; toast.append(text);
  if (action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action.run(); toast.remove(); }
      catch { button.disabled = false; }
    });
    toast.append(button);
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon'; close.textContent = '×'; close.setAttribute('aria-label','Dismiss notification');
  close.addEventListener('click', () => toast.remove()); toast.append(close);
  region.append(toast);
  while (region.children.length > 4) region.firstElementChild.remove();
  if (!action && kind !== 'error') {
    let timer;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => toast.remove(), 5500); };
    toast.addEventListener('mouseenter', () => clearTimeout(timer)); toast.addEventListener('focusin', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', schedule); toast.addEventListener('focusout', schedule); schedule();
  }
}
