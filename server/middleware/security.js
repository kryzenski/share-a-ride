import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const buckets = new Map();

export function rateLimit({ name, limit, windowMs, keyFn }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${keyFn(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      next(new HttpError(429, 'Too many requests. Wait a minute and try again.', 'RATE_LIMITED'));
      return;
    }
    next();
  };
}

export function clientKey(req) {
  return req.user?.employee_id || req.socket?.remoteAddress || 'unknown';
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  if (process.env.COOKIE_SECURE === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.removeHeader('X-Powered-By');
  next();
}

export function originGuard(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const host = req.get('host');
  const selfOrigin = `${req.protocol}://${host}`;
  const allowed = new Set(
    [process.env.ALLOWED_ORIGIN, selfOrigin].filter(Boolean),
  );
  if (!allowed.has(origin)) {
    next(new HttpError(403, 'Origin is not allowed', 'ORIGIN_REJECTED'));
    return;
  }
  next();
}

export function requireJson(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
    next();
    return;
  }
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    next(new HttpError(415, 'Content-Type must be application/json', 'UNSUPPORTED_MEDIA'));
    return;
  }
  const requested = req.get('x-requested-with');
  if (requested !== 'XMLHttpRequest') {
    next(new HttpError(400, 'Missing X-Requested-With header', 'CSRF_HEADER'));
    return;
  }
  next();
}

const PRIVATE_ADDRESS = new RegExp(
  [
    '\\b(flat|apartment|apt|villa|penthouse)\\b',
    '\\b(house|door|plot|unit)\\s*(no\\.?|number|#)?\\s*\\d',
    '#\\s*\\d+',
    '\\bblock\\s*[a-z]?\\s*\\d{2,}\\b',
  ].join('|'),
  'i',
);

export function assertLandmark(value, label) {
  const text = String(value || '').replace(/[<>]/g, '').trim();
  if (text.length < 3 || text.length > 120) {
    throw new HttpError(400, `${label} should be a short landmark or society gate.`, 'VALIDATION');
  }
  if (PRIVATE_ADDRESS.test(text)) {
    throw new HttpError(
      400,
      `${label} looks like a home address. Use a landmark, society gate, or cross street.`,
      'PRIVATE_ADDRESS',
    );
  }
  return text;
}

export function maskPlate(plate) {
  if (!plate) return null;
  const raw = String(plate).trim();
  if (raw.length < 5) return '••••';
  return `${raw.slice(0, 2)}-••-••••`;
}

export function displayNotes(notes) {
  if (!notes) return '';
  return String(notes).replace(/^seed:\s*/i, '');
}

export function audit(eventType, req, payload = {}, severity = 'INFO') {
  const entry = {
    timestamp: new Date().toISOString(),
    event_type: eventType,
    actor_id: req.user?.employee_id || null,
    client_ip: req.socket?.remoteAddress || null,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 240),
    payload,
    severity,
  };
  const line = JSON.stringify(entry);
  if (severity === 'ERROR' || severity === 'WARN') console.error(line);
  else console.log(line);
  const logPath = process.env.LOG_PATH;
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      /* file logging is best-effort */
    }
  }
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    audit('UNHANDLED_ERROR', req, { code: err.code || 'INTERNAL' }, 'ERROR');
    console.error(err);
  } else if (status === 401 || status === 403) {
    audit('UNAUTHORIZED_ACCESS_ATTEMPT', req, { status, code: err.code || 'FORBIDDEN' }, 'WARN');
  }
  const body = {
    error: status >= 500 ? 'Something went wrong on the ride service.' : err.message,
    code: err.code || (status >= 500 ? 'INTERNAL' : 'ERROR'),
  };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}
