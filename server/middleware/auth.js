import crypto from 'node:crypto';
import { pool } from '../db.js';
import { HttpError, audit } from './security.js';

const ACCESS_MS = 15 * 60 * 1000;
const REFRESH_MS = 8 * 60 * 60 * 1000;
const refreshStore = new Map();

function secret() {
  const value = process.env.SESSION_SECRET || '';
  if (value.length < 16) {
    throw new Error('SESSION_SECRET must be at least 16 characters');
  }
  return value;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function readCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieSuffix(maxAge, httpOnly) {
  const parts = [`Path=/`, `Max-Age=${maxAge}`, 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}

function setCookie(res, name, value, maxAge, httpOnly) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieSuffix(maxAge, httpOnly)}`);
}

function clearCookie(res, name, httpOnly) {
  res.append('Set-Cookie', `${name}=; ${cookieSuffix(0, httpOnly)}`);
}

export function issueCsrf(res) {
  const token = crypto.randomBytes(32).toString('hex');
  setCookie(res, 'cp_csrf', token, REFRESH_MS / 1000, false);
  return token;
}

function issueAccess(res, employeeId, absoluteExp) {
  const exp = Math.min(Date.now() + ACCESS_MS, absoluteExp);
  const token = sign({ sub: employeeId, exp });
  setCookie(res, 'cp_session', token, Math.max(1, Math.floor((exp - Date.now()) / 1000)), true);
}

export function establishSession(res, employeeId) {
  const refreshId = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + REFRESH_MS;
  refreshStore.set(refreshId, { sub: employeeId, exp });
  setCookie(res, 'cp_refresh', refreshId, REFRESH_MS / 1000, true);
  issueAccess(res, employeeId, exp);
  issueCsrf(res);
}

export function destroySession(req, res) {
  const cookies = readCookies(req);
  if (cookies.cp_refresh) refreshStore.delete(cookies.cp_refresh);
  clearCookie(res, 'cp_session', true);
  clearCookie(res, 'cp_refresh', true);
  clearCookie(res, 'cp_csrf', false);
}

async function loadEmployee(employeeId) {
  const [rows] = await pool.query(
    `SELECT employee_id, full_name, email, department, role
       FROM employees
      WHERE employee_id = ?`,
    [employeeId],
  );
  const employee = rows[0];
  if (!employee || !String(employee.email).toLowerCase().endsWith('@company.com')) return null;
  return employee;
}

export async function resolveUser(req, res) {
  const cookies = readCookies(req);
  let employeeId = null;
  const access = verify(cookies.cp_session);
  if (access?.sub) {
    employeeId = access.sub;
  } else if (cookies.cp_refresh) {
    const refresh = refreshStore.get(cookies.cp_refresh);
    if (refresh && refresh.exp > Date.now()) {
      employeeId = refresh.sub;
      issueAccess(res, refresh.sub, refresh.exp);
    }
  }
  if (!employeeId) return null;
  return loadEmployee(employeeId);
}

export async function attachUser(req, res, next) {
  try {
    req.user = await resolveUser(req, res);
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(req, res, next) {
  try {
    req.user = req.user || (await resolveUser(req, res));
    if (!req.user) {
      audit('AUTH_LOGIN_FAILURE', req, { reason: 'missing_session' }, 'WARN');
      next(new HttpError(401, 'Sign in with your @company.com account.', 'UNAUTHENTICATED'));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const cookies = readCookies(req);
  const header = String(req.get('x-csrf-token') || '');
  const cookie = cookies.cp_csrf || '';
  const left = Buffer.from(header);
  const right = Buffer.from(cookie);
  if (!header || !cookie || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    next(new HttpError(403, 'CSRF check failed. Reload the page and try again.', 'CSRF'));
    return;
  }
  next();
}

export function assertCompanyEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@company\.com$/.test(value)) {
    throw new HttpError(403, 'Only @company.com accounts can sign in.', 'DOMAIN_REJECTED');
  }
  return value;
}

export function publicEmployee(employee) {
  return {
    employee_id: employee.employee_id,
    full_name: employee.full_name,
    email: employee.email,
    department: employee.department,
    role: employee.role,
  };
}

export const CAMPUSES = [
  'Campus HQ Tower B',
  'Campus HQ Gate 1',
  'Campus HQ Tech Park Gate 2',
];

export function officeTimezone() {
  return process.env.TIMEZONE || 'Asia/Kolkata';
}
