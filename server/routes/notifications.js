import express from 'express';
import { pool, fromSqlUtc } from '../db.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { HttpError, asyncRoute } from '../middleware/security.js';

function present(row) {
  return {
    notification_id: row.notification_id,
    recipient_id: row.recipient_id,
    ride_id: row.ride_id,
    title: row.title,
    message: row.message,
    urgency: row.urgency,
    is_read: Boolean(row.is_read),
    created_at: fromSqlUtc(row.created_at),
  };
}

export function notificationsRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.use(requireCsrf);

  router.get('/', asyncRoute(async (req, res) => {
    const unreadOnly = String(req.query.is_read || '').toLowerCase() === 'false';
    const [rows] = await pool.query(
      `SELECT notification_id, recipient_id, ride_id, title, message, urgency, is_read, created_at
         FROM notifications
        WHERE recipient_id = ?
          ${unreadOnly ? 'AND is_read = FALSE' : ''}
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.user.employee_id],
    );
    res.json({ notifications: rows.map(present) });
  }));

  router.get('/:empId', asyncRoute(async (req, res) => {
    const empId = String(req.params.empId || '');
    if (empId !== req.user.employee_id && req.user.role !== 'ADMIN') {
      throw new HttpError(403, 'You can only read your own alerts.', 'FORBIDDEN');
    }
    const [rows] = await pool.query(
      `SELECT notification_id, recipient_id, ride_id, title, message, urgency, is_read, created_at
         FROM notifications
        WHERE recipient_id = ?
        ORDER BY created_at DESC
        LIMIT 50`,
      [empId],
    );
    res.json({ notifications: rows.map(present) });
  }));

  router.patch('/:id/read', asyncRoute(async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) {
      throw new HttpError(400, 'That alert id is not valid.', 'VALIDATION');
    }
    const [result] = await pool.query(
      `UPDATE notifications
          SET is_read = TRUE
        WHERE notification_id = ? AND recipient_id = ?`,
      [Number(req.params.id), req.user.employee_id],
    );
    if (result.affectedRows !== 1) throw new HttpError(404, 'Alert not found.', 'NOT_FOUND');
    res.json({ notification_id: Number(req.params.id), is_read: true });
  }));

  return router;
}
