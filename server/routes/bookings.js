import express from 'express';
import { pool, fromSqlUtc, withTransactionRetry } from '../db.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { HttpError, asyncRoute, audit, rateLimit, clientKey } from '../middleware/security.js';
import { presentRide } from './rides.js';

const LATE_MINUTES = 15;

function parseId(raw) {
  if (!/^\d+$/.test(String(raw || ''))) {
    throw new HttpError(400, 'That id is not valid.', 'VALIDATION');
  }
  return Number(raw);
}

function minutesUntil(departure) {
  const when = new Date(fromSqlUtc(departure)).getTime();
  return (when - Date.now()) / 60000;
}

async function loadPresented(rideId, viewer, booking) {
  const [rows] = await pool.query(
    `SELECT r.ride_id, r.host_id, r.direction, r.vehicle_type, r.vehicle_details,
            r.vehicle_model, r.license_plate, r.total_seats, r.available_seats,
            r.departure_time, r.pickup_location, r.drop_location, r.route_notes, r.status,
            e.full_name, e.department, e.phone_number
       FROM rides r
       JOIN employees e ON e.employee_id = r.host_id
      WHERE r.ride_id = ?`,
    [rideId],
  );
  if (!rows[0]) return null;
  return presentRide(rows[0], viewer, booking);
}

async function joinRide(req, rideId) {
  if (req.body?.rider_id && req.body.rider_id !== req.user.employee_id) {
    throw new HttpError(403, 'You can only reserve a seat for yourself.', 'FORBIDDEN');
  }
  const booking = await withTransactionRetry(async (conn) => {
    const [locked] = await conn.query(
      `SELECT ride_id, host_id, available_seats, total_seats, status, departure_time
         FROM rides
        WHERE ride_id = ?
        FOR UPDATE`,
      [rideId],
    );
    const ride = locked[0];
    if (!ride) throw new HttpError(404, 'Ride not found.', 'NOT_FOUND');
    if (ride.host_id === req.user.employee_id) {
      throw new HttpError(403, 'Hosts already have a seat on their own ride.', 'FORBIDDEN');
    }
    if (ride.status !== 'OPEN' || ride.available_seats <= 0) {
      throw new HttpError(409, 'Seat no longer available.', 'RIDE_FULL');
    }
    if (new Date(fromSqlUtc(ride.departure_time)).getTime() < Date.now()) {
      throw new HttpError(409, 'This commute has already departed.', 'RIDE_CLOSED');
    }
    const [existing] = await conn.query(
      `SELECT booking_id, booking_status
         FROM ride_bookings
        WHERE ride_id = ? AND rider_id = ? AND booking_status = 'CONFIRMED'
        FOR UPDATE`,
      [rideId, req.user.employee_id],
    );
    if (existing[0]) throw new HttpError(409, 'You already have a seat on this ride.', 'ALREADY_JOINED');

    let bookingId;
    try {
      const [inserted] = await conn.query(
        `INSERT INTO ride_bookings (ride_id, rider_id, booking_status)
         VALUES (?, ?, 'CONFIRMED')`,
        [rideId, req.user.employee_id],
      );
      bookingId = inserted.insertId;
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new HttpError(409, 'You already have a seat on this ride.', 'ALREADY_JOINED');
      }
      throw error;
    }

    const [updated] = await conn.query(
      `UPDATE rides
          SET available_seats = available_seats - 1,
              status = CASE WHEN available_seats - 1 = 0 THEN 'FULL' ELSE 'OPEN' END
        WHERE ride_id = ?
          AND available_seats > 0
          AND status = 'OPEN'`,
      [rideId],
    );
    if (updated.affectedRows !== 1) {
      throw new HttpError(409, 'Seat no longer available.', 'RIDE_FULL');
    }
    return { booking_id: bookingId, ride_id: rideId };
  });

  audit('SEAT_RESERVED', req, { booking_id: booking.booking_id, ride_id: rideId });
  const ride = await loadPresented(rideId, req.user, {
    booking_id: booking.booking_id,
    booking_status: 'CONFIRMED',
    is_late_cancellation: 0,
  });
  req.app.locals.hub?.broadcast({
    type: 'SEAT_UPDATE',
    ride_id: rideId,
    available_seats: ride.available_seats,
    total_seats: ride.total_seats,
    status: ride.status,
  });
  return { booking_id: booking.booking_id, ride };
}

async function cancelBooking(req, { bookingId, rideId }) {
  const hub = req.app.locals.hub;
  const outcome = await withTransactionRetry(async (conn) => {
    const [found] = await conn.query(
      bookingId
        ? `SELECT booking_id, ride_id, rider_id, booking_status
             FROM ride_bookings WHERE booking_id = ? FOR UPDATE`
        : `SELECT booking_id, ride_id, rider_id, booking_status
             FROM ride_bookings
            WHERE ride_id = ? AND rider_id = ? AND booking_status = 'CONFIRMED'
            FOR UPDATE`,
      bookingId ? [bookingId] : [rideId, req.user.employee_id],
    );
    const booking = found[0];
    if (!booking) throw new HttpError(404, 'Booking not found.', 'NOT_FOUND');
    if (booking.booking_status !== 'CONFIRMED') {
      throw new HttpError(409, 'That seat is already cancelled.', 'ALREADY_CANCELLED');
    }

    const [locked] = await conn.query(
      `SELECT ride_id, host_id, available_seats, total_seats, status, departure_time,
              pickup_location, drop_location
         FROM rides WHERE ride_id = ? FOR UPDATE`,
      [booking.ride_id],
    );
    const ride = locked[0];
    if (!ride) throw new HttpError(404, 'Ride not found.', 'NOT_FOUND');

    const isRider = booking.rider_id === req.user.employee_id;
    const isHost = ride.host_id === req.user.employee_id;
    if (!isRider && !isHost) {
      throw new HttpError(403, 'You can only cancel your own seat.', 'FORBIDDEN');
    }

    const delta = minutesUntil(ride.departure_time);
    const late = delta >= 0 && delta <= LATE_MINUTES;
    await conn.query(
      `UPDATE ride_bookings
          SET booking_status = 'CANCELLED',
              cancelled_at = UTC_TIMESTAMP(),
              is_late_cancellation = ?
        WHERE booking_id = ?`,
      [late ? 1 : 0, booking.booking_id],
    );

    if (ride.status !== 'CANCELLED' && ride.status !== 'COMPLETED') {
      await conn.query(
        `UPDATE rides
            SET available_seats = available_seats + 1,
                status = 'OPEN'
          WHERE ride_id = ?
            AND available_seats < total_seats`,
        [ride.ride_id],
      );
    }

    let notification = null;
    if (late) {
      const [riderRows] = await conn.query(
        'SELECT full_name FROM employees WHERE employee_id = ?',
        [booking.rider_id],
      );
      const riderName = riderRows[0]?.full_name || 'A colleague';
      const minutes = Math.max(0, Math.round(delta));
      const title = 'Urgent: passenger cancelled within 15 min';
      const message = `${riderName} cancelled their seat for the commute from ${ride.pickup_location} to ${ride.drop_location} with ${minutes} minute${minutes === 1 ? '' : 's'} to departure. The seat is back on the board.`;
      const [inserted] = await conn.query(
        `INSERT INTO notifications (recipient_id, ride_id, title, message, urgency)
         VALUES (?, ?, ?, ?, 'URGENT')`,
        [ride.host_id, ride.ride_id, title, message],
      );
      notification = {
        notification_id: inserted.insertId,
        recipient_id: ride.host_id,
        ride_id: ride.ride_id,
        title,
        message,
        urgency: 'URGENT',
        is_read: false,
        created_at: new Date().toISOString(),
      };
    }

    const [fresh] = await conn.query(
      'SELECT available_seats, total_seats, status FROM rides WHERE ride_id = ?',
      [ride.ride_id],
    );
    return {
      booking_id: booking.booking_id,
      ride_id: ride.ride_id,
      host_id: ride.host_id,
      late,
      minutes_before_departure: Math.round(delta),
      notification,
      seats: fresh[0],
    };
  });

  audit(outcome.late ? 'LATE_CANCELLATION_TRIGGERED' : 'SEAT_CANCELLED', req, {
    booking_id: outcome.booking_id,
    ride_id: outcome.ride_id,
    minutes_before_departure: outcome.minutes_before_departure,
    is_late_cancellation: outcome.late,
  });

  hub?.broadcast({
    type: 'SEAT_UPDATE',
    ride_id: outcome.ride_id,
    available_seats: outcome.seats.available_seats,
    total_seats: outcome.seats.total_seats,
    status: outcome.seats.status,
  });
  if (outcome.late && outcome.notification) {
    hub?.send(outcome.host_id, {
      type: 'LATE_CANCELLATION',
      notification: outcome.notification,
      ride_id: outcome.ride_id,
      available_seats: outcome.seats.available_seats,
      total_seats: outcome.seats.total_seats,
      status: outcome.seats.status,
    });
  }

  const ride = await loadPresented(outcome.ride_id, req.user, {
    booking_id: outcome.booking_id,
    booking_status: 'CANCELLED',
    is_late_cancellation: outcome.late ? 1 : 0,
  });
  return {
    booking_id: outcome.booking_id,
    is_late_cancellation: outcome.late,
    ride,
  };
}

export function bookingsRouter() {
  const router = express.Router();
  const bookingLimit = rateLimit({
    name: 'book',
    limit: 5,
    windowMs: 60 * 1000,
    keyFn: clientKey,
  });

  router.post('/rides/:id/join', requireAuth, requireCsrf, bookingLimit, asyncRoute(async (req, res) => {
    const result = await joinRide(req, parseId(req.params.id));
    res.status(200).json(result);
  }));

  router.post('/rides/:id/book', requireAuth, requireCsrf, bookingLimit, asyncRoute(async (req, res) => {
    const result = await joinRide(req, parseId(req.params.id));
    res.status(200).json(result);
  }));

  router.post('/rides/:id/cancel', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    const result = await cancelBooking(req, { rideId: parseId(req.params.id) });
    res.json(result);
  }));

  router.delete('/bookings/:id', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    const result = await cancelBooking(req, { bookingId: parseId(req.params.id) });
    res.json(result);
  }));

  return router;
}
