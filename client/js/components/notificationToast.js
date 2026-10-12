function toaster() {
  let el = document.getElementById('toaster');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toaster';
    el.className = 'toaster';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

export function showToast({ title, message, urgent = false }) {
  const toast = document.createElement('div');
  toast.className = `toast${urgent ? ' toast-urgent' : ''}`;
  toast.setAttribute('role', urgent ? 'alert' : 'status');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  toast.append(heading, copy);
  toaster().append(toast);
  setTimeout(() => toast.remove(), 6400);
}
