import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'),
});

const limit = Math.min(25, Math.max(10, Number(process.env.DB_CONNECTION_LIMIT || 20)));

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'commutepool_app',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'commutepool',
  waitForConnections: true,
  connectionLimit: limit,
  queueLimit: Number(process.env.DB_QUEUE_LIMIT || 0),
  connectTimeout: 5000,
  timezone: 'Z',
  dateStrings: true,
  enableKeepAlive: true,
  multipleStatements: false,
});

pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
  connection.query('SET SESSION innodb_lock_wait_timeout = 5');
});

export async function healthCheck() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1 AS ok');
    return true;
  } finally {
    conn.release();
  }
}

export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* connection may already be closed */
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function withTransactionRetry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await withTransaction(fn);
    } catch (error) {
      last = error;
      if (error.code !== 'ER_LOCK_DEADLOCK' && error.code !== 'ER_LOCK_WAIT_TIMEOUT') {
        throw error;
      }
    }
  }
  throw last;
}

export function toSqlUtc(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

export function fromSqlUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim().replace(' ', 'T');
  return text.endsWith('Z') ? text : `${text}Z`;
}

const SEED_OFFSETS_MINUTES = {
  1: 45,
  2: 30,
  3: 80,
  4: 360,
  5: 420,
  6: 12,
  7: 120,
  8: 1800,
};

export async function refreshSeedSchedule() {
  const flag = process.env.DEMO_REFRESH_SCHEDULE;
  const enabled = flag === 'true' || (flag !== 'false' && process.env.NODE_ENV !== 'production');
  if (!enabled) return;
  for (const [id, minutes] of Object.entries(SEED_OFFSETS_MINUTES)) {
    await pool.query(
      `UPDATE rides
         SET departure_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
       WHERE ride_id = ? AND route_notes LIKE 'seed:%'`,
      [minutes, Number(id)],
    );
  }
}

export async function waitForDatabase(tries = 30) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      await healthCheck();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last;
}
