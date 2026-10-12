const filled = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#38BDF8"></circle><circle cx="12" cy="9.5" r="3" fill="#fff"></circle><path d="M7 17.5c.9-2 2.6-3 5-3s4.1 1 5 3" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"></path></svg>`;
const open = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="#38BDF8" stroke-width="2"></circle></svg>`;

export function renderSeatCircles(total, available) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeAvailable = Math.max(0, Math.min(safeTotal, Number(available) || 0));
  const booked = safeTotal - safeAvailable;
  let html = `<div class="seat-avatars" aria-label="${safeAvailable} of ${safeTotal} seats open">`;
  for (let i = 0; i < booked; i += 1) {
    html += `<span class="seat-bubble filled" title="Occupied seat">${filled}</span>`;
  }
  for (let j = 0; j < safeAvailable; j += 1) {
    html += `<span class="seat-bubble open" title="Open seat">${open}</span>`;
  }
  html += `<span class="seat-label">${safeAvailable}/${safeTotal} left</span></div>`;
  return html;
}
