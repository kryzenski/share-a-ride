# Share-A-Ride

Share-A-Ride (CommutePool) is an internal rideshare board for colleagues on `@company.com`. Employees offer empty seats in a personal car or bike, or split an Uber Auto or Rapido Auto, for the commute to the office or back home.

The board follows the local clock. From midnight until 11:59 it opens on **To Office**. From noon it opens on **From Office**. A rider who cancels with 15 minutes or less until departure is marked as a late cancellation, the seat returns to the board, and the host receives an urgent in-app alert.

## Features

- Corporate sign-in limited to `@company.com` employees
- Ride offers for a personal car, a personal bike (one seat), Uber Auto, and Rapido Auto
- Direction defaulted from the device clock, with a manual override
- Date chips, landmark search, and a visual seat count
- Atomic seat reservation with row locks, so the last seat cannot be double-booked
- Late-cancellation rule at 15 minutes, with a WebSocket alert to the host
- Phone numbers and license plates hidden until a seat is mutually reserved
- Home addresses rejected in favor of landmarks and society gates

## Tech stack

| Layer | Choice |
| :--- | :--- |
| Browser | HTML, CSS, and ES modules. No build step. |
| API | Node.js, Express, and `ws` |
| Database | MySQL 8 or MariaDB 10.11, with parameterized SQL |

## Repository layout

```text
client/                 Dashboard and My Rides pages
server/                 Express API, auth, and SQL routes
schema.sql              Tables, constraints, and seed data
docker-compose.yml      MySQL, API, and Nginx
nginx.conf              Reverse proxy and security headers
```

## Prerequisites

- Node.js 20 or newer
- MySQL 8 or MariaDB 10.11
- npm 10 or newer

## Getting started

Create the database and a least-privilege user:

```sql
CREATE DATABASE commutepool CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'commutepool_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-secret';
GRANT SELECT, INSERT, UPDATE, DELETE ON commutepool.* TO 'commutepool_app'@'127.0.0.1';
```

Load the schema and seed data:

```bash
mysql -u root -p commutepool < schema.sql
```

Configure the API, then start it. The same process serves the browser app.

```bash
cp server/.env.example server/.env
cd server
npm install
npm start
```

Open the URL for `PORT` in `server/.env` (3000 by default). In local demo mode, choose a seeded colleague on the sign-in sheet. There is no public registration.

## Demo accounts

| Name | Email | Department |
| :--- | :--- | :--- |
| Aditi Rao | aditi.rao@company.com | Engineering |
| Rohan Verma | rohan.verma@company.com | Design |
| Sara Fernandes | sara.fernandes@company.com | HR |
| Vikram Iyer | vikram.iyer@company.com | Marketing |
| Neha Kapoor | neha.kapoor@company.com | Engineering |
| Imran Shah | imran.shah@company.com | Finance |
| Priya Nair | priya.nair@company.com | Product |
| Kabir Mehta | kabir.mehta@company.com | Operations |

Priya’s morning car is about 12 minutes from departure and already has two riders. Sign in as Vikram Iyer or Kabir Mehta and leave that ride to see the 15-minute warning.

## Configuration

Copy `server/.env.example` to `server/.env`. Set `DB_PASS` and a `SESSION_SECRET` of at least 16 characters. Do not commit `server/.env`.

Before a shared deployment:

- Set `NODE_ENV=production` and `COOKIE_SECURE=true`.
- Set `AUTH_MODE=password`, or place corporate SSO in front of `POST /api/auth/login`.
- Set `DEMO_REFRESH_SCHEDULE=false` so startup does not move the seeded departure times.
- Replace the sample database passwords in `docker-compose.yml`.

Session cookies are `HttpOnly` and `SameSite=Lax`. The access cookie lasts 15 minutes and slides while the tab is in use, bounded by an 8-hour refresh cookie. Mutating requests send `X-CSRF-Token`, matched against the `cp_csrf` cookie.

## Docker

```bash
docker compose up -d --build
```

This starts MySQL, the API, and Nginx. Change the default passwords before anyone else can reach the host.

## API

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Process and database status |
| `POST` | `/api/auth/login` | Sign in with a `@company.com` employee |
| `GET` | `/api/rides?direction=TO_OFFICE` | Open board |
| `POST` | `/api/rides` | Publish a ride |
| `PUT` | `/api/rides/:id` | Host edits a ride |
| `DELETE` | `/api/rides/:id` | Host cancels a ride |
| `POST` | `/api/rides/:id/join` | Reserve a seat |
| `DELETE` | `/api/bookings/:id` | Rider or host releases a seat |
| `GET` | `/api/notifications` | Alerts for the signed-in employee |
| `PATCH` | `/api/notifications/:id/read` | Mark an alert read |

Seat changes run in a transaction. The ride row is locked with `SELECT ... FOR UPDATE`, then the booking is inserted and the seat count is updated. A full ride returns **409 Conflict**.

## Checks

```bash
curl -s http://127.0.0.1:3000/api/health
cd server && SMOKE_BASE=http://127.0.0.1:3000 node smoke.mjs
```

`smoke.mjs` covers health, the corporate domain gate, masked phone and plate, private-address rejection, host-only edits, a one-seat race (one `200`, one `409`), the 15-minute late cancel, and the bike’s locked single seat.

## License

This project is licensed under the [MIT License](LICENSE).
