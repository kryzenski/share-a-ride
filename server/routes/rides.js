import express from 'express';
import { pool, toSqlUtc, fromSqlUtc, withTransactionRetry } from '../db.js';
import { requireAuth, requireCsrf, CAMPUSES } from '../middleware/auth.js';
import {
  HttpError,
  asyncRoute,
  assertLandmark,
  maskPlate,
  displayNotes,
  audit,
} from '../middleware/security.js';

const VEHICLES = new Set(['CAR', 'BIKE', 'UBER_AUTO', 'RAPIDO_AUTO']);
const DIRECTIONS = new Set(['TO_OFFICE', 'FROM_OFFICE']);

function parseId(raw) {
  if (!/^\d+$/.test(String(raw || ''))) {
    throw new HttpError(400, 'That ride id is not valid.', 'VALIDATION');
  }
  return Number(raw);
}

function clean(value, max) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function assertSeatCount(vehicleType, seats) {
  if (!Number.isInteger(seats)) {
    throw new HttpError(400, 'Seat count must be a whole number.', 'VALIDATION');
  }
  if (vehicleType === 'BIKE' && seats !== 1) {
    throw new HttpError(400, 'Personal bikes are locked to 1 seat.', 'VALIDATION');
  }
  if ((vehicleType === 'UBER_AUTO' || vehicleType === 'RAPIDO_AUTO') && (seats < 2 || seats > 3)) {
    throw new HttpError(400, 'Shared autos allow 2 or 3 seats.', 'VALIDATION');
  }
  if (vehicleType === 'CAR' && (seats < 1 || seats > 4)) {
    throw new HttpError(400, 'Cars allow 1 to 4 seats.', 'VALIDATION');
  }
}

function normalizePlate(plate) {
  const value = String(plate || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!/^[A-Z0-9][A-Z0-9 -]{4,18}$/.test(value)) {
    throw new HttpError(400, 'Enter a license plate like KA-03-HA-4411.', 'VALIDATION');
  }
  return value;
}

function assertWorkingHours(date) {
  const tz = process.env.TIMEZONE || 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const minutes = hour * 60 + minute;
  if (minutes < 6 * 60 || minutes > 22 * 60) {
    throw new HttpError(400, 'Departure must be between 6:00 AM and 10:00 PM office time.', 'OUTSIDE_HOURS');
  }
}

function parseDeparture(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'Departure time is not a valid date.', 'VALIDATION');
  }
  if (date.getTime() < Date.now() - 60 * 1000) {
    throw new HttpError(400, 'Departure time must be in the future.', 'VALIDATION');
  }
  assertWorkingHours(date);
  return date;
}

export function resolveLocations(direction, pickup, drop) {
  if (direction === 'TO_OFFICE') {
    const pickupLocation = assertLandmark(pickup, 'Pickup');
    const dropLocation = clean(drop, 120);
    if (!CAMPUSES.includes(dropLocation)) {
      throw new HttpError(400, 'Choose a campus building for the office drop.', 'VALIDATION');
    }
    return { pickupLocation, dropLocation };
  }
  const pickupLocation = clean(pickup, 120);
  if (!CAMPUSES.includes(pickupLocation)) {
    throw new HttpError(400, 'Choose a campus building for the office pickup.', 'VALIDATION');
  }
  const dropLocation = assertLandmark(drop, 'Drop');
  return { pickupLocation, dropLocation };
}

function vehicleRecord(body) {
  const vehicleType = String(body.vehicle_type || '').toUpperCase();
  if (!VEHICLES.has(vehicleType)) {
    throw new HttpError(400, 'Choose a car, bike, Uber Auto, or Rapido Auto.', 'VALIDATION');
  }
  const seats = Number(body.total_seats);
  assertSeatCount(vehicleType, seats);
  if (vehicleType === 'UBER_AUTO' || vehicleType === 'RAPIDO_AUTO') {
    const label = vehicleType === 'UBER_AUTO' ? 'Uber Auto' : 'Rapido Auto';
    return {
      vehicleType,
      seats,
      model: label,
      plate: null,
      details: `${label} (Booking Initiator)`,
    };
  }
  const model = clean(body.vehicle_model, 40);
  if (model.length < 2) {
    throw new HttpError(400, 'Enter the vehicle model.', 'VALIDATION');
  }
  const plate = normalizePlate(body.license_plate);
  return {
    vehicleType,
    seats,
    model,
    plate,
    details: `${model} (${plate})`.slice(0, 150),
  };
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function presentRide(row, viewer, booking = null) {
  const viewerId = viewer?.employee_id;
  const isHost = Boolean(viewerId && row.host_id === viewerId);
  const isRider = Boolean(booking && booking.booking_status === 'CONFIRMED');
  const privileged = isHost || isRider;
  const auto = row.vehicle_type === 'UBER_AUTO' || row.vehicle_type === 'RAPIDO_AUTO';
  const publicDetails = auto
    ? `${row.vehicle_model || 'Shared auto'} Share`
    : `${row.vehicle_model || 'Vehicle'} | ${maskPlate(row.license_plate) || 'plate hidden'}`;
  return {
    ride_id: row.ride_id,
    host_id: row.host_id,
    host_name: row.full_name,
    host_department: row.department,
    host_phone: privileged ? row.phone_number : null,
    direction: row.direction,
    vehicle_type: row.vehicle_type,
    vehicle_model: row.vehicle_model,
    license_plate: privileged ? row.license_plate : maskPlate(row.license_plate),
    vehicle_details: privileged ? row.vehicle_details : publicDetails,
    total_seats: row.total_seats,
    available_seats: row.available_seats,
    departure_time: fromSqlUtc(row.departure_time),
    pickup_location: row.pickup_location,
    drop_location: row.drop_location,
    route_notes: displayNotes(row.route_notes),
    status: row.status,
    is_host: isHost,
    is_rider: isRider,
    booking_id: booking?.booking_id || null,
    booking_status: booking?.booking_status || null,
    is_late_cancellation: booking ? Boolean(booking.is_late_cancellation) : false,
  };
}

const RIDE_SELECT = `
  SELECT r.ride_id, r.host_id, r.direction, r.vehicle_type, r.vehicle_details,
         r.vehicle_model, r.license_plate, r.total_seats, r.available_seats,
         r.departure_time, r.pickup_location, r.drop_location, r.route_notes, r.status,
         e.full_name, e.department, e.phone_number
    FROM rides r
    JOIN employees e ON e.employee_id = r.host_id
`;

async function bookingsFor(rideIds, viewerId) {
  if (!rideIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT booking_id, ride_id, rider_id, booking_status, is_late_cancellation
       FROM ride_bookings
      WHERE rider_id = ? AND ride_id IN (?)
      ORDER BY booking_id ASC`,
    [viewerId, rideIds],
  );
  const map = new Map();
  for (const row of rows) {
    const current = map.get(row.ride_id);
    if (!current || row.booking_status === 'CONFIRMED' || (current.booking_status !== 'CONFIRMED' && row.booking_id > current.booking_id)) {
      map.set(row.ride_id, row);
    }
  }
  return map;
}

async function passengersFor(rideIds, privilegedRideIds) {
  if (!rideIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT b.booking_id, b.ride_id, b.rider_id, b.booking_status, b.is_late_cancellation,
            e.full_name, e.department, e.phone_number
       FROM ride_bookings b
       JOIN employees e ON e.employee_id = b.rider_id
      WHERE b.ride_id IN (?) AND b.booking_status = 'CONFIRMED'
      ORDER BY b.booked_at ASC`,
    [rideIds],
  );
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.ride_id) || [];
    const showPhone = privilegedRideIds.has(row.ride_id);
    list.push({
      booking_id: row.booking_id,
      rider_id: row.rider_id,
      full_name: row.full_name,
      department: row.department,
      phone_number: showPhone ? row.phone_number : null,
      is_late_cancellation: Boolean(row.is_late_cancellation),
    });
    map.set(row.ride_id, list);
  }
  return map;
}

export function ridesRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.use(requireCsrf);

  router.get('/', asyncRoute(async (req, res) => {
    const scope = String(req.query.scope || 'feed');
    const viewer = req.user;
    let rows;

    if (scope === 'hosted') {
      const [hosted] = await pool.query(
        `${RIDE_SELECT} WHERE r.host_id = ? ORDER BY r.departure_time DESC LIMIT 100`,
        [viewer.employee_id],
      );
      rows = hosted;
    } else if (scope === 'joined') {
      const [joined] = await pool.query(
        `${RIDE_SELECT}
          WHERE r.ride_id IN (SELECT ride_id FROM ride_bookings WHERE rider_id = ?)
          ORDER BY r.departure_time DESC
          LIMIT 100`,
        [viewer.employee_id],
      );
      rows = joined;
    } else {
      const direction = String(req.query.direction || '');
      if (!DIRECTIONS.has(direction)) {
        throw new HttpError(400, 'direction must be TO_OFFICE or FROM_OFFICE.', 'VALIDATION');
      }
      const status = String(req.query.status || 'OPEN');
      const statuses = status === 'ALL' ? ['OPEN', 'FULL'] : status.split(',').filter((item) => ['OPEN', 'FULL'].includes(item));
      if (!statuses.length) throw new HttpError(400, 'Unsupported status filter.', 'VALIDATION');
      const search = clean(req.query.q, 80);
      const params = [direction, ...statuses];
      let searchSql = '';
      if (search) {
        const pattern = likePattern(search);
        searchSql = ` AND (r.pickup_location LIKE ? ESCAPE '\\\\' OR r.drop_location LIKE ? ESCAPE '\\\\')`;
        params.push(pattern, pattern);
      }
      const statusSql = statuses.map(() => '?').join(', ');
      const [feed] = await pool.query(
        `${RIDE_SELECT}
          WHERE r.direction = ?
            AND r.status IN (${statusSql})
            AND r.departure_time >= UTC_TIMESTAMP() - INTERVAL 20 MINUTE
            ${searchSql}
          ORDER BY r.departure_time ASC
          LIMIT 200`,
        params,
      );
      rows = feed;
    }

    const ids = rows.map((row) => row.ride_id);
    const bookingMap = await bookingsFor(ids, viewer.employee_id);
    const rides = rows.map((row) => presentRide(row, viewer, bookingMap.get(row.ride_id)));
    res.json({ rides });
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const rideId = parseId(req.params.id);
    const [rows] = await pool.query(`${RIDE_SELECT} WHERE r.ride_id = ?`, [rideId]);
    if (!rows[0]) throw new HttpError(404, 'Ride not found.', 'NOT_FOUND');
    const bookingMap = await bookingsFor([rideId], req.user.employee_id);
    const ride = presentRide(rows[0], req.user, bookingMap.get(rideId));
    const privileged = new Set(ride.is_host || ride.is_rider ? [rideId] : []);
    const people = await passengersFor([rideId], privileged);
    ride.passengers = people.get(rideId) || [];
    res.json({ ride });
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (body.host_id && body.host_id !== req.user.employee_id) {
      throw new HttpError(403, 'You can only publish rides for yourself.', 'FORBIDDEN');
    }
    const direction = String(body.direction || '');
    if (!DIRECTIONS.has(direction)) {
      throw new HttpError(400, 'Choose To Office or From Office.', 'VALIDATION');
    }
    const vehicle = vehicleRecord(body);
    const departure = parseDeparture(body.departure_time);
    const locations = resolveLocations(direction, body.pickup_location, body.drop_location);
    const notes = clean(body.route_notes, 240);

    const [result] = await pool.query(
      `INSERT INTO rides (
         host_id, direction, vehicle_type, vehicle_details, vehicle_model, license_plate,
         total_seats, available_seats, departure_time, pickup_location, drop_location, route_notes, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      [
        req.user.employee_id,
        direction,
        vehicle.vehicleType,
        vehicle.details,
        vehicle.model,
        vehicle.plate,
        vehicle.seats,
        vehicle.seats,
        toSqlUtc(departure),
        locations.pickupLocation,
        locations.dropLocation,
        notes || null,
      ],
    );

    audit('RIDE_CREATED', req, { ride_id: result.insertId, direction, vehicle_type: vehicle.vehicleType });
    const [rows] = await pool.query(`${RIDE_SELECT} WHERE r.ride_id = ?`, [result.insertId]);
    res.status(201).json({ ride: presentRide(rows[0], req.user, null) });
  }));

  router.put('/:id', asyncRoute(async (req, res) => {
    const rideId = parseId(req.params.id);
    const body = req.body || {};
    const ride = await withTransactionRetry(async (conn) => {
      const [locked] = await conn.query(
        `SELECT ride_id, host_id, direction, vehicle_type, total_seats, available_seats, status
           FROM rides WHERE ride_id = ? FOR UPDATE`,
        [rideId],
      );
      const current = locked[0];
      if (!current) throw new HttpError(404, 'Ride not found.', 'NOT_FOUND');
      if (current.host_id !== req.user.employee_id) {
        throw new HttpError(403, 'Only the host can edit this ride.', 'FORBIDDEN');
      }
      if (current.status === 'CANCELLED' || current.status === 'COMPLETED') {
        throw new HttpError(409, 'This ride can no longer be edited.', 'RIDE_CLOSED');
      }

      const direction = body.direction ? String(body.direction) : current.direction;
      if (!DIRECTIONS.has(direction)) throw new HttpError(400, 'Direction is not valid.', 'VALIDATION');
      const vehicleType = body.vehicle_type ? String(body.vehicle_type).toUpperCase() : current.vehicle_type;
      const next = {
        vehicle_type: vehicleType,
        total_seats: body.total_seats != null ? Number(body.total_seats) : current.total_seats,
        vehicle_model: body.vehicle_model,
        license_plate: body.license_plate,
      };
      const vehicle = body.vehicle_type || body.vehicle_model || body.license_plate || body.total_seats != null
        ? vehicleRecord({ ...current, ...body, vehicle_type: vehicleType, total_seats: next.total_seats })
        : null;

      const seats = vehicle ? vehicle.seats : current.total_seats;
      const type = vehicle ? vehicle.vehicleType : current.vehicle_type;
      assertSeatCount(type, seats);
      const booked = current.total_seats - current.available_seats;
      if (seats < booked) {
        throw new HttpError(409, `This ride already has ${booked} confirmed rider${booked === 1 ? '' : 's'}.`, 'SEATS_IN_USE');
      }
      const available = seats - booked;
      const departure = body.departure_time ? parseDeparture(body.departure_time) : null;
      const locations = (body.pickup_location || body.drop_location)
        ? resolveLocations(
          direction,
          body.pickup_location || (direction === current.direction ? undefined : ''),
          body.drop_location || '',
        )
        : null;

      if ((body.pickup_location || body.drop_location) && !locations) {
        throw new HttpError(400, 'Pickup and drop are required when you change the route.', 'VALIDATION');
      }

      const [existing] = await conn.query(
        'SELECT pickup_location, drop_location, route_notes, vehicle_model, license_plate, vehicle_details FROM rides WHERE ride_id = ?',
        [rideId],
      );
      const prev = existing[0];
      let pickup = prev.pickup_location;
      let drop = prev.drop_location;
      if (body.pickup_location || body.drop_location || body.direction) {
        const resolved = resolveLocations(
          direction,
          body.pickup_location ?? prev.pickup_location,
          body.drop_location ?? prev.drop_location,
        );
        pickup = resolved.pickupLocation;
        drop = resolved.dropLocation;
      }
      const notes = body.route_notes != null ? clean(body.route_notes, 240) : prev.route_notes;

      await conn.query(
        `UPDATE rides
            SET direction = ?,
                vehicle_type = ?,
                vehicle_details = ?,
                vehicle_model = ?,
                license_plate = ?,
                total_seats = ?,
                available_seats = ?,
                departure_time = COALESCE(?, departure_time),
                pickup_location = ?,
                drop_location = ?,
                route_notes = ?,
                status = ?
          WHERE ride_id = ?`,
        [
          direction,
          type,
          vehicle ? vehicle.details : prev.vehicle_details,
          vehicle ? vehicle.model : prev.vehicle_model,
          vehicle ? vehicle.plate : prev.license_plate,
          seats,
          available,
          departure ? toSqlUtc(departure) : null,
          pickup,
          drop,
          notes || null,
          available === 0 ? 'FULL' : 'OPEN',
          rideId,
        ],
      );
      return rideId;
    });

    audit('RIDE_UPDATED', req, { ride_id: ride });
    const [rows] = await pool.query(`${RIDE_SELECT} WHERE r.ride_id = ?`, [ride]);
    const bookingMap = await bookingsFor([ride], req.user.employee_id);
    res.json({ ride: presentRide(rows[0], req.user, bookingMap.get(ride)) });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const rideId = parseId(req.params.id);
    const hub = req.app.locals.hub;
    const outcome = await withTransactionRetry(async (conn) => {
      const [locked] = await conn.query(
        `SELECT ride_id, host_id, status, pickup_location, drop_location
           FROM rides WHERE ride_id = ? FOR UPDATE`,
        [rideId],
      );
      const ride = locked[0];
      if (!ride) throw new HttpError(404, 'Ride not found.', 'NOT_FOUND');
      if (ride.host_id !== req.user.employee_id && req.user.role !== 'ADMIN') {
        throw new HttpError(403, 'Only the host can cancel this ride.', 'FORBIDDEN');
      }
      if (ride.status === 'CANCELLED') {
        throw new HttpError(409, 'This ride is already cancelled.', 'RIDE_CLOSED');
      }
      const [passengers] = await conn.query(
        `SELECT b.booking_id, b.rider_id, e.full_name
           FROM ride_bookings b
           JOIN employees e ON e.employee_id = b.rider_id
          WHERE b.ride_id = ? AND b.booking_status = 'CONFIRMED'
          FOR UPDATE`,
        [rideId],
      );
      await conn.query(
        `UPDATE rides SET status = 'CANCELLED' WHERE ride_id = ?`,
        [rideId],
      );
      await conn.query(
        `UPDATE ride_bookings
            SET booking_status = 'CANCELLED',
                cancelled_at = UTC_TIMESTAMP(),
                is_late_cancellation = FALSE
          WHERE ride_id = ? AND booking_status = 'CONFIRMED'`,
        [rideId],
      );
      const title = 'Ride cancelled by the host';
      const message = `${req.user.full_name} cancelled the commute from ${ride.pickup_location} to ${ride.drop_location}.`;
      for (const passenger of passengers) {
        await conn.query(
          `INSERT INTO notifications (recipient_id, ride_id, title, message, urgency)
           VALUES (?, ?, ?, ?, 'URGENT')`,
          [passenger.rider_id, rideId, title, message],
        );
      }
      return { passengers, title, message };
    });

    audit('RIDE_CANCELLED', req, { ride_id: rideId, passengers: outcome.passengers.length });
    for (const passenger of outcome.passengers) {
      hub?.send(passenger.rider_id, {
        type: 'RIDE_CANCELLED',
        ride_id: rideId,
        title: outcome.title,
        message: outcome.message,
      });
    }
    hub?.broadcast({ type: 'FEED_CHANGED', ride_id: rideId, status: 'CANCELLED' });
    res.json({ ride_id: rideId, status: 'CANCELLED' });
  }));

  return router;
}
