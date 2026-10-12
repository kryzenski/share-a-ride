/**
 * 00:00–11:59 → TO_OFFICE, 12:00–23:59 → FROM_OFFICE.
 * Uses the device local clock, not the server timezone.
 */
export function getDefaultCommuteDirection(date = new Date()) {
  const hour = date.getHours();
  return hour >= 0 && hour < 12 ? 'TO_OFFICE' : 'FROM_OFFICE';
}

export function bindDirectionToggle(root, onChange) {
  let locked = false;

  function apply(direction, fromUser = false) {
    if (fromUser) locked = true;
    root.querySelectorAll('[data-direction]').forEach((button) => {
      const active = button.dataset.direction === direction;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    onChange(direction);
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-direction]');
    if (!button) return;
    apply(button.dataset.direction, true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !locked) {
      apply(getDefaultCommuteDirection(), false);
    }
  });

  apply(getDefaultCommuteDirection(), false);
  return {
    apply,
    isLocked: () => locked,
  };
}
