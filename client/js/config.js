export const CAMPUSES = [
  'Campus HQ Tower B',
  'Campus HQ Gate 1',
  'Campus HQ Tech Park Gate 2',
];

export const OFFICE = {
  name: 'Campus HQ Tower B',
  address: 'Global Technology Park, Bellandur, Bengaluru, KA 560103',
  timezone: 'Asia/Kolkata',
};

export const LATE_CANCEL_MINUTES = 15;
export const POLL_MS = 30000;

export const API = {
  config: '/api/auth/config',
  directory: '/api/directory',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/me',
  rides: '/api/rides',
  notifications: '/api/notifications',
};

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
