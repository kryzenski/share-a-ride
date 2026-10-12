const base = process.env.SMOKE_BASE || 'http://127.0.0.1:47231';

function jar() {
  const cookies = new Map();
  return {
    store(response) {
      const list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
      for (const cookie of list) {
        const pair = cookie.split(';')[0];
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    header() {
      return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    csrf() {
      return decodeURIComponent(cookies.get('cp_csrf') || '');
    },
  };
}

async function request(cookies, path, { method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookies) headers.Cookie = cookies.header();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookies && method !== 'GET') headers['X-CSRF-Token'] = cookies.csrf();
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (cookies) cookies.store(response);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login(email) {
  const cookies = jar();
  const result = await request(cookies, '/api/auth/login', { method: 'POST', body: { email } });
  assert(result.status === 200, `login ${email} failed ${result.status} ${JSON.stringify(result.data)}`);
  return cookies;
}

const health = await request(null, '/api/health');
assert(health.status === 200 && health.data.db === 'CONNECTED', 'health check failed');

const outsider = await request(null, '/api/auth/login', { method: 'POST', body: { email: 'person@gmail.com' } });
assert(outsider.status === 403, 'non-company email should be rejected');

const host = await login('aditi.rao@company.com');
const riderA = await login('sara.fernandes@company.com');
const riderB = await login('vikram.iyer@company.com');
const stranger = await login('neha.kapoor@company.com');

const departure = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const created = await request(host, '/api/rides', {
  method: 'POST',
  body: {
    direction: 'TO_OFFICE',
    vehicle_type: 'CAR',
    vehicle_model: 'Smoke Test City',
    license_plate: 'KA-09-SM-1001',
    total_seats: 1,
    departure_time: departure,
    pickup_location: 'Indiranagar Metro',
    drop_location: 'Campus HQ Tower B',
    route_notes: 'Smoke test seat.',
  },
});
assert(created.status === 201, `create ride failed ${created.status} ${JSON.stringify(created.data)}`);
const rideId = created.data.ride.ride_id;

const hidden = await request(stranger, `/api/rides/${rideId}`);
assert(hidden.status === 200, 'detail failed');
assert(hidden.data.ride.host_phone == null, 'phone leaked before a shared seat');
assert(String(hidden.data.ride.license_plate).includes('•'), 'plate was not masked');

const blocked = await request(host, '/api/rides', {
  method: 'POST',
  body: {
    direction: 'FROM_OFFICE',
    vehicle_type: 'CAR',
    vehicle_model: 'Smoke Test City',
    license_plate: 'KA-09-SM-1002',
    total_seats: 1,
    departure_time: departure,
    pickup_location: 'Campus HQ Gate 1',
    drop_location: 'Flat 402, Block B',
    route_notes: 'should fail',
  },
});
assert(blocked.status === 400 && blocked.data.code === 'PRIVATE_ADDRESS', 'private address was accepted');

const idor = await request(stranger, `/api/rides/${rideId}`, {
  method: 'PUT',
  body: { departure_time: departure, total_seats: 1 },
});
assert(idor.status === 403, 'IDOR update was allowed');

const [first, second] = await Promise.all([
  request(riderA, `/api/rides/${rideId}/join`, { method: 'POST', body: {} }),
  request(riderB, `/api/rides/${rideId}/join`, { method: 'POST', body: {} }),
]);
const statuses = [first.status, second.status].sort();
assert(statuses[0] === 200 && statuses[1] === 409, `expected 200 and 409, got ${statuses}`);
const winner = first.status === 200 ? { cookies: riderA, body: first.data } : { cookies: riderB, body: second.data };

const revealed = await request(winner.cookies, `/api/rides/${rideId}`);
assert(revealed.data.ride.host_phone, 'phone stayed hidden after joining');

const cancelled = await request(winner.cookies, `/api/bookings/${winner.body.booking_id}`, { method: 'DELETE' });
assert(cancelled.status === 200, `cancel failed ${cancelled.status} ${JSON.stringify(cancelled.data)}`);
assert(cancelled.data.is_late_cancellation === true, 'late cancellation flag missing');
assert(cancelled.data.ride.available_seats === 1, 'seat was not restocked');
assert(cancelled.data.ride.status === 'OPEN', 'ride did not reopen');

const notes = await request(host, '/api/notifications?is_read=false');
assert(
  notes.data.notifications.some((item) => item.ride_id === rideId && item.urgency === 'URGENT'),
  'host did not receive the urgent alert',
);

const earlyDeparture = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const early = await request(host, '/api/rides', {
  method: 'POST',
  body: {
    direction: 'TO_OFFICE',
    vehicle_type: 'BIKE',
    vehicle_model: 'TVS Jupiter',
    license_plate: 'KA-09-SM-1003',
    total_seats: 2,
    departure_time: earlyDeparture,
    pickup_location: 'Koramangala Sony Signal',
    drop_location: 'Campus HQ Gate 1',
  },
});
assert(early.status === 400, 'bike seat lock was not enforced');

console.log(JSON.stringify({ ok: true, rideId, late: true }));
