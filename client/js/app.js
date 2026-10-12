import { API, CAMPUSES, LATE_CANCEL_MINUTES, POLL_MS } from './config.js';
import { store, patchRide } from './store.js';
import { api } from './services/api.js';
import { connectSocket } from './services/socket.js';
import { bindDirectionToggle } from './components/directionToggle.js';
import { renderSeatCircles } from './components/seatVisualizer.js';
import { showToast } from './components/notificationToast.js';

const page = document.body.dataset.page;
let socket;
let pollTimer;

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function rideDateKey(iso) {
  return dateKey(new Date(iso));
}

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function formatDate(iso) {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

function relative(iso) {
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  if (mins < -1) return 'Departed';
  if (mins <= 0) return 'Departing now';
  if (mins < 60) return `Departs in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `Departs in ${hours}h ${rest}m` : `Departs in ${hours}h`;
}

function estimatedArrival(iso) {
  return formatTime(new Date(new Date(iso).getTime() + 40 * 60 * 1000).toISOString());
}

function dateChips() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    let label = day.toLocaleDateString(undefined, { weekday: 'long' });
    if (index === 0) label = 'Today';
    if (index === 1) label = 'Tomorrow';
    return { key: dateKey(day), label };
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function pill(text) {
  const span = document.createElement('span');
  span.className = 'pill';
  span.textContent = text;
  return span;
}

function seatPhrase(ride) {
  if (ride.available_seats <= 0) return 'Full';
  if (ride.available_seats === 1) return '1 seat left';
  return `${ride.available_seats} seats left`;
}

function emptyBlock(title, message, actionLabel, action) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.className = 'muted';
  copy.textContent = message;
  wrap.append(heading, copy);
  if (actionLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary';
    button.style.marginTop = '12px';
    button.textContent = actionLabel;
    button.addEventListener('click', action);
    wrap.append(button);
  }
  return wrap;
}

function placeBlock(name, time) {
  const wrap = document.createElement('div');
  const place = document.createElement('div');
  place.className = 'tl-place';
  place.textContent = name;
  const when = document.createElement('div');
  when.className = 'tl-time';
  when.textContent = time;
  wrap.append(place, when);
  return wrap;
}

function timeline(ride) {
  const grid = document.createElement('div');
  grid.className = 'timeline';
  const origin = document.createElement('span');
  origin.className = 'tl-mark origin';
  origin.title = 'Pickup';
  const arrow = document.createElement('span');
  arrow.className = 'tl-arrow';
  arrow.textContent = '↓';
  const pin = document.createElement('span');
  pin.className = 'tl-mark';
  pin.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="#38BDF8" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"></path></svg>';
  const mid = document.createElement('div');
  mid.className = 'tl-time';
  mid.textContent = relative(ride.departure_time);
  grid.append(
    origin,
    placeBlock(ride.pickup_location, formatTime(ride.departure_time)),
    arrow,
    mid,
    pin,
    placeBlock(ride.drop_location, `est. ${estimatedArrival(ride.departure_time)}`),
  );
  return grid;
}

function rideCard(ride, mode) {
  const card = document.createElement('article');
  card.className = 'ride-card';
  card.dataset.rideId = String(ride.ride_id);
  if (ride.ride_id === store.get().highlight) card.classList.add('is-highlight');

  const host = document.createElement('div');
  host.className = 'host-row';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(ride.host_name);
  const copy = document.createElement('div');
  copy.className = 'host-copy';
  const name = document.createElement('h2');
  name.textContent = ride.host_name;
  const vehicle = document.createElement('p');
  vehicle.className = 'vehicle-line';
  vehicle.textContent = ride.vehicle_details;
  const when = document.createElement('p');
  when.className = 'date-line';
  when.textContent = formatDate(ride.departure_time);
  const meta = document.createElement('div');
  meta.className = 'meta-row';
  meta.append(pill(ride.host_department), pill(seatPhrase(ride)));
  copy.append(name, vehicle, when, meta);
  host.append(avatar, copy);

  const seats = document.createElement('div');
  seats.innerHTML = renderSeatCircles(ride.total_seats, ride.available_seats);
  card.append(host, timeline(ride), seats);

  if (mode === 'board') {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'btn btn-primary btn-block';
    if (ride.is_host) {
      cta.textContent = 'Manage My Ride';
      cta.dataset.action = 'manage';
    } else if (ride.is_rider) {
      cta.textContent = 'Leave Ride';
      cta.dataset.action = 'leave';
    } else if (ride.available_seats <= 0 || ride.status !== 'OPEN') {
      cta.textContent = 'Full';
      cta.disabled = true;
    } else {
      cta.textContent = 'Join Ride';
      cta.dataset.action = 'join';
    }
    card.append(cta);
  } else {
    const status = document.createElement('p');
    status.className = 'status-line';
    status.textContent = mode === 'hosted'
      ? `Status · ${ride.status}`
      : `Booking · ${ride.booking_status || 'UNKNOWN'}${ride.is_late_cancellation ? ' · late cancel' : ''}`;
    card.append(status);
  }
  return card;
}

function paintUser() {
  const user = store.get().user;
  const chip = document.getElementById('userChip');
  if (!user || !chip) return;
  chip.hidden = false;
  chip.replaceChildren();
  const avatar = document.createElement('span');
  avatar.className = 'avatar sm';
  avatar.textContent = initials(user.full_name);
  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = user.full_name.split(' ')[0];
  const dept = document.createElement('span');
  dept.textContent = user.department;
  text.append(strong, dept);
  chip.append(avatar, text);
  const menuName = document.getElementById('userMenuName');
  if (menuName) menuName.textContent = `${user.full_name} · ${user.email}`;
}

function paintBell() {
  const badge = document.getElementById('bellCount');
  const panel = document.getElementById('notifPanel');
  if (!badge || !panel) return;
  const items = store.get().notifications;
  const unread = items.filter((item) => !item.is_read);
  badge.hidden = unread.length === 0;
  badge.textContent = String(unread.length);
  panel.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.padding = '10px';
    empty.textContent = 'No alerts yet.';
    panel.append(empty);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `notif-item${item.is_read ? '' : ' unread'}${item.urgency === 'URGENT' ? ' urgent' : ''}`;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const message = document.createElement('span');
    message.textContent = item.message;
    button.append(title, message);
    button.addEventListener('click', () => markRead(item));
    panel.append(button);
  });
}

async function refreshNotifications() {
  if (!store.get().user) return;
  try {
    const data = await api(API.notifications);
    store.set({ notifications: data.notifications });
    paintBell();
  } catch {
    /* keep the last list */
  }
}

async function markRead(item) {
  if (!item.is_read) {
    try {
      await api(`${API.notifications}/${item.notification_id}/read`, { method: 'PATCH', body: {} });
    } catch {
      /* the panel will refresh anyway */
    }
  }
  document.getElementById('notifPanel').hidden = true;
  await refreshNotifications();
}

function onSocket(event) {
  if (event.type === 'SEAT_UPDATE') {
    patchRide(event.ride_id, {
      available_seats: event.available_seats,
      total_seats: event.total_seats,
      status: event.status,
    });
    if (page === 'board') renderFeed();
    if (page === 'my-rides') renderMine();
  }
  if (event.type === 'LATE_CANCELLATION') {
    showToast({
      title: event.notification.title,
      message: event.notification.message,
      urgent: true,
    });
    refreshNotifications();
  }
  if (event.type === 'RIDE_CANCELLED') {
    showToast({ title: event.title, message: event.message, urgent: true });
    refreshNotifications();
    if (page === 'board') loadRides();
    if (page === 'my-rides') loadMine();
  }
  if (event.type === 'FEED_CHANGED' && page === 'board') loadRides();
}

function bindShell() {
  document.getElementById('bell')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = document.getElementById('notifPanel');
    panel.hidden = !panel.hidden;
    document.getElementById('userMenu').hidden = true;
  });
  document.getElementById('userChip')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = document.getElementById('userMenu');
    menu.hidden = !menu.hidden;
    document.getElementById('notifPanel').hidden = true;
  });
  document.addEventListener('click', () => {
    const panel = document.getElementById('notifPanel');
    const menu = document.getElementById('userMenu');
    if (panel) panel.hidden = true;
    if (menu) menu.hidden = true;
  });
  document.getElementById('notifPanel')?.addEventListener('click', (event) => event.stopPropagation());
  document.getElementById('userMenu')?.addEventListener('click', (event) => event.stopPropagation());
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try {
      await api(API.logout, { method: 'POST', body: {} });
    } catch {
      /* leave the page either way */
    }
    location.href = '/';
  });
}

async function showLogin() {
  document.getElementById('loginView')?.removeAttribute('hidden');
  document.getElementById('appView')?.setAttribute('hidden', '');
  document.getElementById('directionToggle')?.setAttribute('hidden', '');
  const mode = store.get().config?.authMode || 'demo';
  const passwordField = document.getElementById('passwordField');
  if (passwordField) passwordField.hidden = mode !== 'password';
  const mount = document.getElementById('directory');
  const hint = document.getElementById('loginHint');
  if (hint) {
    hint.textContent = mode === 'password'
      ? 'Use your @company.com email and the workspace password.'
      : 'Local demo: pick your name. Production replaces this picker with corporate SSO.';
  }
  try {
    const data = await api(API.directory);
    store.set({ directory: data.employees });
  } catch (error) {
    mount.textContent = error.message;
    return;
  }
  mount.replaceChildren();
  if (mode === 'demo') {
    dataEmployees().forEach((person) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'person';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initials(person.full_name);
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = person.full_name;
      const meta = document.createElement('small');
      meta.textContent = `${person.department} · ${person.email}`;
      copy.append(name, document.createElement('br'), meta);
      button.append(avatar, copy);
      button.addEventListener('click', () => login(person.email));
      mount.append(button);
    });
  }
  const form = document.getElementById('loginForm');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      login(
        document.getElementById('emailInput').value,
        document.getElementById('passwordInput')?.value,
      );
    });
  }
}

function dataEmployees() {
  return store.get().directory;
}

async function login(email, password) {
  const error = document.getElementById('loginError');
  if (error) error.textContent = '';
  try {
    const body = { email };
    if (password) body.password = password;
    await api(API.login, { method: 'POST', body });
    location.reload();
  } catch (err) {
    if (error) error.textContent = err.message;
  }
}

async function enterApp() {
  paintUser();
  document.getElementById('loginView')?.setAttribute('hidden', '');
  document.getElementById('appView')?.removeAttribute('hidden');
  document.getElementById('directionToggle')?.removeAttribute('hidden');
  await refreshNotifications();
  socket = connectSocket(onSocket);
  if (page === 'board') startBoard();
  if (page === 'my-rides') startMine();
  pollTimer = setInterval(() => {
    refreshNotifications();
    if (page === 'board') loadRides();
    if (page === 'my-rides') loadMine();
  }, POLL_MS);
}

function upsertLocal(ride) {
  const rides = store.get().rides.slice();
  const index = rides.findIndex((item) => item.ride_id === ride.ride_id);
  if (index === -1) rides.unshift(ride);
  else rides[index] = { ...rides[index], ...ride };
  store.set({ rides });
}

async function loadRides() {
  const { direction, query } = store.get();
  if (!direction) return;
  try {
    const params = new URLSearchParams({ direction, status: 'OPEN,FULL' });
    if (query) params.set('q', query);
    const data = await api(`${API.rides}?${params}`);
    store.set({ rides: data.rides, status: 'ready', error: '' });
  } catch (error) {
    store.set({ status: 'error', error: error.message, rides: [] });
  }
  renderFeed();
}

function renderChips() {
  const row = document.getElementById('dateRow');
  if (!row) return;
  row.replaceChildren();
  dateChips().forEach((chip) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${chip.key === store.get().dateKey ? ' is-active' : ''}`;
    button.textContent = chip.label;
    button.addEventListener('click', () => {
      store.set({ dateKey: chip.key });
      renderChips();
      renderFeed();
    });
    row.append(button);
  });
}

function visibleRides() {
  return store.get().rides.filter((ride) => rideDateKey(ride.departure_time) === store.get().dateKey);
}

function renderFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const { status, error } = store.get();
  feed.replaceChildren();
  if (status === 'loading') {
    for (let i = 0; i < 3; i += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton';
      feed.append(skeleton);
    }
    return;
  }
  if (status === 'error') {
    feed.append(emptyBlock('The board did not load', error || 'Try again in a moment.', 'Retry', () => {
      store.set({ status: 'loading' });
      renderFeed();
      loadRides();
    }));
    return;
  }
  const rides = visibleRides();
  if (!rides.length) {
    feed.append(emptyBlock(
      'No commutes this way yet',
      'Post a ride and split the trip with your team.',
      'Post a ride',
      () => openRideDialog(),
    ));
    return;
  }
  rides.forEach((ride) => feed.append(rideCard(ride, 'board')));
}

async function onFeedClick(event) {
  const button = event.target.closest('button');
  const card = event.target.closest('.ride-card');
  if (!card) return;
  const ride = store.get().rides.find((item) => item.ride_id === Number(card.dataset.rideId));
  if (!ride) return;
  if (!button) {
    openDetails(ride.ride_id);
    return;
  }
  if (button.dataset.action === 'join') joinRide(ride, button);
  if (button.dataset.action === 'leave') confirmCancel(ride);
  if (button.dataset.action === 'manage') {
    location.href = `/my-rides.html#ride-${ride.ride_id}`;
  }
}

async function joinRide(ride, button) {
  if (button) button.disabled = true;
  try {
    const result = await api(`${API.rides}/${ride.ride_id}/join`, { method: 'POST', body: {} });
    upsertLocal(result.ride);
    showToast({ title: 'Seat reserved', message: `You're riding with ${result.ride.host_name}.` });
    renderFeed();
  } catch (error) {
    showToast({ title: 'Could not join', message: error.message, urgent: true });
    loadRides();
  }
}

function confirmCancel(ride) {
  const dialog = document.getElementById('confirmDialog');
  const minutes = (new Date(ride.departure_time) - Date.now()) / 60000;
  const late = minutes >= 0 && minutes <= LATE_CANCEL_MINUTES;
  document.getElementById('confirmTitle').textContent = late ? 'Cancel within 15 minutes?' : 'Leave this ride?';
  document.getElementById('confirmBody').textContent = late
    ? 'You are cancelling within 15 minutes of departure. Your host will be alerted immediately and your seat will be opened to others.'
    : 'Your seat will reopen for teammates on the board.';
  const yes = document.getElementById('confirmYes');
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      const result = ride.booking_id
        ? await api(`/api/bookings/${ride.booking_id}`, { method: 'DELETE' })
        : await api(`${API.rides}/${ride.ride_id}/cancel`, { method: 'POST', body: {} });
      dialog.close();
      showToast({
        title: result.is_late_cancellation ? 'Host alerted' : 'Seat released',
        message: result.is_late_cancellation
          ? 'Your host was notified and the seat is back on the board.'
          : 'The seat is available for someone else.',
        urgent: result.is_late_cancellation,
      });
      if (page === 'board') loadRides();
      else loadMine();
    } catch (error) {
      showToast({ title: 'Cancellation failed', message: error.message, urgent: true });
    } finally {
      yes.disabled = false;
    }
  };
  dialog.showModal();
}

function confirmHostCancel(ride) {
  const dialog = document.getElementById('confirmDialog');
  document.getElementById('confirmTitle').textContent = 'Cancel this ride?';
  document.getElementById('confirmBody').textContent = 'Every confirmed passenger will be notified and the ride will leave the board. The record stays for audit.';
  const yes = document.getElementById('confirmYes');
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      await api(`${API.rides}/${ride.ride_id}`, { method: 'DELETE' });
      dialog.close();
      showToast({ title: 'Ride cancelled', message: 'Passengers have been notified.' });
      loadMine();
    } catch (error) {
      showToast({ title: 'Could not cancel', message: error.message, urgent: true });
    } finally {
      yes.disabled = false;
    }
  };
  dialog.showModal();
}

async function openDetails(id) {
  const dialog = document.getElementById('detailsDialog');
  const body = document.getElementById('detailsBody');
  body.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'muted';
  loading.textContent = 'Loading ride…';
  body.append(loading);
  dialog.showModal();
  try {
    const data = await api(`${API.rides}/${id}`);
    paintDetails(data.ride);
  } catch (error) {
    body.textContent = error.message;
  }
}

function paintDetails(ride) {
  const body = document.getElementById('detailsBody');
  body.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = ride.host_name;
  const meta = document.createElement('p');
  meta.className = 'vehicle-line';
  meta.textContent = `${ride.vehicle_details} · ${ride.host_department}`;
  const phone = document.createElement('p');
  phone.className = 'muted';
  phone.textContent = ride.host_phone
    ? `Host phone ${ride.host_phone}`
    : 'Phone numbers stay hidden until you share this ride.';
  const notes = document.createElement('p');
  notes.textContent = ride.route_notes || 'No route notes.';
  const peopleTitle = document.createElement('h3');
  peopleTitle.textContent = 'Confirmed riders';
  peopleTitle.style.margin = '12px 0 8px';
  const list = document.createElement('div');
  list.className = 'passenger-list';
  if (!ride.passengers?.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No one has joined yet.';
    list.append(none);
  } else {
    ride.passengers.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'passenger';
      const name = document.createElement('span');
      name.textContent = `${person.full_name} · ${person.department}`;
      row.append(name);
      if (person.phone_number) {
        const contact = document.createElement('span');
        contact.className = 'muted';
        contact.textContent = person.phone_number;
        row.append(contact);
      }
      list.append(row);
    });
  }
  const seats = document.createElement('div');
  seats.innerHTML = renderSeatCircles(ride.total_seats, ride.available_seats);
  body.append(heading, meta, timeline(ride), seats, phone, notes, peopleTitle, list);

  if (!ride.is_host && !ride.is_rider && ride.status === 'OPEN' && ride.available_seats > 0) {
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'btn btn-primary btn-block';
    join.textContent = 'Join Ride';
    join.addEventListener('click', async () => {
      await joinRide(ride, join);
      document.getElementById('detailsDialog').close();
    });
    body.append(join);
  }
  if (ride.is_rider && ride.booking_status === 'CONFIRMED') {
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'btn btn-danger btn-block';
    leave.textContent = 'Leave Ride';
    leave.addEventListener('click', () => {
      document.getElementById('detailsDialog').close();
      confirmCancel(ride);
    });
    body.append(leave);
  }
}

function campuses() {
  return store.get().config?.campuses || CAMPUSES;
}

function textField(name, label, placeholder) {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" required maxlength="120" placeholder="${esc(placeholder)}"></label>`;
}

function selectField(name, label, options) {
  const opts = options.map((option) => `<option value="${esc(option)}">${esc(option)}</option>`).join('');
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}" required>${opts}</select></label>`;
}

function syncRideForm() {
  const form = document.getElementById('rideForm');
  if (!form) return;
  const prevPickup = form.elements.pickup_location?.value || form.dataset.pickup || '';
  const prevDrop = form.elements.drop_location?.value || form.dataset.drop || '';
  const direction = form.elements.direction.value;
  const type = form.elements.vehicle_type.value;
  const auto = type === 'UBER_AUTO' || type === 'RAPIDO_AUTO';
  const bike = type === 'BIKE';
  form.querySelector('[data-vehicle-fields]').hidden = auto;
  const seats = form.elements.total_seats;
  const previous = Number(form.dataset.seats || seats.value || (bike ? 1 : auto ? 2 : 3));
  const options = bike ? [1] : auto ? [2, 3] : [1, 2, 3, 4];
  seats.replaceChildren();
  options.forEach((count) => {
    const option = document.createElement('option');
    option.value = String(count);
    option.textContent = String(count);
    seats.append(option);
  });
  seats.value = String(options.includes(previous) ? previous : options[0]);
  form.dataset.seats = '';
  seats.disabled = bike;
  form.elements.vehicle_model.required = !auto;
  form.elements.license_plate.required = !auto;
  form.elements.ride_date.min = dateKey(new Date());
  const pickupMount = document.getElementById('pickupMount');
  const dropMount = document.getElementById('dropMount');
  if (direction === 'TO_OFFICE') {
    pickupMount.innerHTML = textField('pickup_location', 'Pickup landmark', 'Indiranagar Metro');
    dropMount.innerHTML = selectField('drop_location', 'Office drop', campuses());
  } else {
    pickupMount.innerHTML = selectField('pickup_location', 'Office pickup', campuses());
    dropMount.innerHTML = textField('drop_location', 'Drop landmark', 'Green Glen Layout Gate 2');
  }
  if (form.elements.pickup_location && prevPickup) form.elements.pickup_location.value = prevPickup;
  if (form.elements.drop_location && prevDrop) form.elements.drop_location.value = prevDrop;
  form.dataset.pickup = '';
  form.dataset.drop = '';
}

function openRideDialog(existing) {
  const form = document.getElementById('rideForm');
  const dialog = document.getElementById('rideDialog');
  form.reset();
  form.dataset.mode = existing ? 'edit' : 'create';
  form.dataset.rideId = existing ? String(existing.ride_id) : '';
  document.getElementById('rideDialogTitle').textContent = existing ? 'Edit ride' : 'Post a ride';
  document.getElementById('rideSubmit').textContent = existing ? 'Save changes' : 'Publish Ride Offer';
  document.getElementById('rideError').textContent = '';
  const direction = existing?.direction || store.get().direction || 'TO_OFFICE';
  form.elements.direction.value = direction;
  form.elements.vehicle_type.value = existing?.vehicle_type || 'CAR';
  form.elements.vehicle_model.value = existing?.vehicle_model && existing.vehicle_type !== 'UBER_AUTO' && existing.vehicle_type !== 'RAPIDO_AUTO'
    ? existing.vehicle_model
    : '';
  form.elements.license_plate.value = existing?.license_plate && !String(existing.license_plate).includes('•')
    ? existing.license_plate
    : '';
  form.elements.route_notes.value = existing?.route_notes || '';
  form.dataset.seats = existing ? String(existing.total_seats) : '';
  const when = existing ? new Date(existing.departure_time) : new Date(Date.now() + 60 * 60 * 1000);
  form.elements.ride_date.value = dateKey(when);
  form.elements.ride_time.value = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  form.elements.total_seats.value = String(existing?.total_seats || (form.elements.vehicle_type.value === 'BIKE' ? 1 : 3));
  form.dataset.pickup = existing?.pickup_location || '';
  form.dataset.drop = existing?.drop_location || '';
  syncRideForm();
  dialog.showModal();
}

async function submitRide(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('rideError');
  error.textContent = '';
  const departure = new Date(`${form.elements.ride_date.value}T${form.elements.ride_time.value}`);
  if (Number.isNaN(departure.getTime())) {
    error.textContent = 'Choose a valid date and time.';
    return;
  }
  const payload = {
    direction: form.elements.direction.value,
    vehicle_type: form.elements.vehicle_type.value,
    vehicle_model: form.elements.vehicle_model.value,
    license_plate: form.elements.license_plate.value,
    total_seats: Number(form.elements.total_seats.value),
    departure_time: departure.toISOString(),
    pickup_location: form.elements.pickup_location.value,
    drop_location: form.elements.drop_location.value,
    route_notes: form.elements.route_notes.value,
  };
  const submit = document.getElementById('rideSubmit');
  submit.disabled = true;
  try {
    const editing = form.dataset.mode === 'edit';
    const data = editing
      ? await api(`${API.rides}/${form.dataset.rideId}`, { method: 'PUT', body: payload })
      : await api(API.rides, { method: 'POST', body: payload });
    document.getElementById('rideDialog').close();
    showToast({
      title: editing ? 'Ride updated' : 'Ride published',
      message: editing ? 'Colleagues will see the new details.' : 'It is on the board for your team.',
    });
    if (page === 'board') {
      store.set({
        direction: data.ride.direction,
        dateKey: rideDateKey(data.ride.departure_time),
      });
      document.querySelectorAll('#directionToggle [data-direction]').forEach((button) => {
        const active = button.dataset.direction === data.ride.direction;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      renderChips();
      loadRides();
    } else {
      loadMine();
    }
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function startBoard() {
  store.set({ dateKey: dateKey(new Date()), status: 'loading' });
  renderChips();
  renderFeed();
  bindDirectionToggle(document.getElementById('directionToggle'), (direction) => {
    store.set({ direction, rides: [], status: 'loading', error: '' });
    renderFeed();
    loadRides();
  });
  let searchTimer;
  document.getElementById('searchInput').addEventListener('input', (event) => {
    store.set({ query: event.target.value.trim() });
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadRides, 250);
  });
  document.getElementById('postRideBtn').addEventListener('click', () => openRideDialog());
  document.getElementById('feed').addEventListener('click', onFeedClick);
  document.getElementById('rideForm').addEventListener('submit', submitRide);
  document.getElementById('rideForm').addEventListener('change', (event) => {
    if (event.target.name === 'direction' || event.target.name === 'vehicle_type') syncRideForm();
  });
  bindDialogs();
}

async function loadMine() {
  const scope = store.get().tab || 'hosted';
  try {
    const data = await api(`${API.rides}?scope=${scope}`);
    store.set({ rides: data.rides, status: 'ready', error: '' });
  } catch (error) {
    store.set({ status: 'error', error: error.message, rides: [] });
  }
  renderMine();
}

function renderMine() {
  const feed = document.getElementById('mineFeed');
  if (!feed) return;
  const { status, error, tab } = store.get();
  feed.replaceChildren();
  if (status === 'loading' && !store.get().rides.length) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    feed.append(skeleton);
    return;
  }
  if (status === 'error') {
    feed.append(emptyBlock('My rides did not load', error, 'Retry', loadMine));
    return;
  }
  const rides = store.get().rides;
  if (!rides.length) {
    feed.append(emptyBlock(
      tab === 'hosted' ? 'You have not offered a ride' : 'You have not joined a ride',
      tab === 'hosted'
        ? 'Publish an empty seat from the board when you are heading in.'
        : 'Browse the board and reserve a seat with a colleague.',
      tab === 'hosted' ? 'Go to the board' : 'Find a ride',
      () => { location.href = '/'; },
    ));
    return;
  }
  rides.forEach((ride) => {
    const card = rideCard(ride, tab === 'hosted' ? 'hosted' : 'joined');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (tab === 'hosted' && ride.status !== 'CANCELLED' && ride.status !== 'COMPLETED') {
      actions.append(mini('Edit', 'edit'), mini('Cancel ride', 'cancel-ride', 'btn-danger'));
    }
    if (tab === 'joined' && ride.booking_status === 'CONFIRMED' && ride.status !== 'CANCELLED') {
      actions.append(mini('Leave ride', 'leave', 'btn-danger'));
    }
    if (actions.childElementCount) card.append(actions);
    feed.append(card);
  });
  const highlight = feed.querySelector('.is-highlight');
  highlight?.scrollIntoView({ block: 'center' });
}

function mini(label, action, extra = 'btn-ghost') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${extra}`;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function switchTab(tab) {
  store.set({ tab, rides: [], status: 'loading' });
  document.getElementById('tabHosted').classList.toggle('is-active', tab === 'hosted');
  document.getElementById('tabJoined').classList.toggle('is-active', tab === 'joined');
  document.getElementById('tabHosted').setAttribute('aria-selected', String(tab === 'hosted'));
  document.getElementById('tabJoined').setAttribute('aria-selected', String(tab === 'joined'));
  renderMine();
  loadMine();
}

function onMineClick(event) {
  const button = event.target.closest('button');
  const card = event.target.closest('.ride-card');
  if (!card) return;
  const ride = store.get().rides.find((item) => item.ride_id === Number(card.dataset.rideId));
  if (!ride) return;
  if (!button) {
    openDetails(ride.ride_id);
    return;
  }
  if (button.dataset.action === 'edit') openRideDialog(ride);
  if (button.dataset.action === 'cancel-ride') confirmHostCancel(ride);
  if (button.dataset.action === 'leave') confirmCancel(ride);
}

function startMine() {
  const hash = location.hash.match(/^#ride-(\d+)$/);
  store.set({
    tab: 'hosted',
    status: 'loading',
    highlight: hash ? Number(hash[1]) : null,
  });
  document.getElementById('tabHosted').addEventListener('click', () => switchTab('hosted'));
  document.getElementById('tabJoined').addEventListener('click', () => switchTab('joined'));
  document.getElementById('mineFeed').addEventListener('click', onMineClick);
  const form = document.getElementById('rideForm');
  form?.addEventListener('submit', submitRide);
  form?.addEventListener('change', (event) => {
    if (event.target.name === 'direction' || event.target.name === 'vehicle_type') syncRideForm();
  });
  bindDialogs();
  loadMine();
}

function bindDialogs() {
  document.getElementById('closeRide')?.addEventListener('click', () => document.getElementById('rideDialog').close());
  document.getElementById('closeDetails')?.addEventListener('click', () => document.getElementById('detailsDialog').close());
  document.getElementById('confirmNo')?.addEventListener('click', () => document.getElementById('confirmDialog').close());
}

async function boot() {
  bindShell();
  try {
    store.set({ config: await api(API.config) });
  } catch {
    store.set({ config: null });
  }
  try {
    const me = await api(API.me);
    store.set({ user: me.user });
  } catch {
    store.set({ user: null });
  }
  if (!store.get().user) {
    await showLogin();
    return;
  }
  await enterApp();
}

boot();

window.addEventListener('pagehide', () => {
  clearInterval(pollTimer);
  socket?.close();
});
