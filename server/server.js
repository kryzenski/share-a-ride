import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { pool, healthCheck, refreshSeedSchedule, waitForDatabase } from './db.js';
import {
  securityHeaders,
  originGuard,
  requireJson,
  rateLimit,
  clientKey,
  errorHandler,
  audit,
  HttpError,
} from './middleware/security.js';
import {
  attachUser,
  requireAuth,
  requireCsrf,
  resolveUser,
  establishSession,
  destroySession,
  issueCsrf,
  readCookies,
  assertCompanyEmail,
  publicEmployee,
  CAMPUSES,
} from './middleware/auth.js';
import { ridesRouter } from './routes/rides.js';
import { bookingsRouter } from './routes/bookings.js';
import { notificationsRouter } from './routes/notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

function createHub() {
  const sockets = new Map();
  return {
    add(employeeId, ws) {
      const set = sockets.get(employeeId) || new Set();
      set.add(ws);
      sockets.set(employeeId, set);
      ws.on('close', () => {
        set.delete(ws);
        if (set.size === 0) sockets.delete(employeeId);
      });
    },
    send(employeeId, event) {
      const set = sockets.get(employeeId);
      if (!set) return;
      const payload = JSON.stringify(event);
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },
    broadcast(event) {
      const payload = JSON.stringify(event);
      for (const set of sockets.values()) {
        for (const ws of set) {
          if (ws.readyState === ws.OPEN) ws.send(payload);
        }
      }
    },
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.locals.hub = createHub();

  app.use(securityHeaders);
  app.use(originGuard);
  app.use(express.json({ limit: '100kb' }));
  app.use(attachUser);

  app.get('/api/health', async (_req, res) => {
    try {
      await healthCheck();
      res.json({ status: 'UP', db: 'CONNECTED' });
    } catch {
      res.status(503).json({ status: 'DOWN', db: 'DISCONNECTED' });
    }
  });

  app.get('/api/auth/config', (_req, res) => {
    res.json({
      authMode: process.env.AUTH_MODE === 'password' ? 'password' : 'demo',
      domain: '@company.com',
      campuses: CAMPUSES,
      officeName: process.env.OFFICE_NAME || 'Campus HQ Tower B',
      timezone: process.env.TIMEZONE || 'Asia/Kolkata',
    });
  });

  app.get('/api/directory', async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT employee_id, full_name, email, department
           FROM employees
          ORDER BY full_name ASC`,
      );
      res.json({ employees: rows });
    } catch (error) {
      next(error);
    }
  });

  const loginLimit = rateLimit({
    name: 'login',
    limit: 10,
    windowMs: 60 * 1000,
    keyFn: (req) => req.socket?.remoteAddress || 'unknown',
  });

  app.post('/api/auth/login', loginLimit, requireJson, async (req, res, next) => {
    try {
      const email = assertCompanyEmail(req.body?.email);
      if (process.env.AUTH_MODE === 'password') {
        const expected = process.env.DEMO_PASSWORD || '';
        const given = String(req.body?.password || '');
        if (!expected || expected.length < 8 || given !== expected) {
          audit('AUTH_LOGIN_FAILURE', req, { reason: 'password' }, 'WARN');
          throw new HttpError(401, 'Email or password was not accepted.', 'AUTH_FAILED');
        }
      }
      const [rows] = await pool.query(
        `SELECT employee_id, full_name, email, department, role
           FROM employees
          WHERE email = ?`,
        [email],
      );
      const employee = rows[0];
      if (!employee) {
        audit('AUTH_LOGIN_FAILURE', req, { reason: 'unknown_email' }, 'WARN');
        throw new HttpError(401, 'No employee record matches that email.', 'AUTH_FAILED');
      }
      establishSession(res, employee.employee_id);
      audit('AUTH_LOGIN_SUCCESS', req, { employee_id: employee.employee_id });
      res.json({ user: publicEmployee(employee) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
    destroySession(req, res);
    audit('AUTH_LOGOUT', req, {});
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    const cookies = readCookies(req);
    if (!cookies.cp_csrf) issueCsrf(res);
    res.json({ user: publicEmployee(req.user) });
  });

  const apiLimit = rateLimit({
    name: 'api',
    limit: 60,
    windowMs: 60 * 1000,
    keyFn: clientKey,
  });
  app.use('/api', apiLimit);
  app.use('/api', requireJson);
  app.use('/api/rides', ridesRouter());
  app.use('/api', bookingsRouter());
  app.use('/api/notifications', notificationsRouter());

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir, {
    extensions: ['html'],
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));

  app.use(errorHandler);
  return app;
}

function attachWebSocket(server, hub) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    try {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        const allowed = new Set([process.env.ALLOWED_ORIGIN, `http://${host}`, `https://${host}`].filter(Boolean));
        if (!allowed.has(origin)) {
          ws.close(1008, 'origin');
          return;
        }
      }
      const fakeRes = { append() {}, setHeader() {}, getHeader() { return undefined; } };
      const user = await resolveUser(req, fakeRes);
      if (!user) {
        ws.close(1008, 'auth');
        return;
      }
      hub.add(user.employee_id, ws);
      ws.send(JSON.stringify({ type: 'ready', employee_id: user.employee_id }));
    } catch {
      ws.close(1011, 'error');
    }
  });
  return wss;
}

export async function start() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
    throw new Error('Set SESSION_SECRET in server/.env before starting');
  }
  await waitForDatabase();
  await refreshSeedSchedule();
  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server, app.locals.hub);
  const port = Number(process.env.PORT || 3000);
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(JSON.stringify({
    event_type: 'SERVER_LISTEN',
    port,
    auth_mode: process.env.AUTH_MODE === 'password' ? 'password' : 'demo',
  }));
  return server;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
