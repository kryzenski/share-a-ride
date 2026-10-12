# CommutePool (Share-A-Ride)

Internal rideshare board for `@company.com` colleagues. People offer empty seats in a personal car or bike, or split an Uber Auto / Rapido Auto, for the commute **to office** or **from office**.

The morning board (00:00–11:59, device local time) opens on **To Office**. From noon it opens on **From Office**. A rider who cancels with 15 minutes or less until departure is flagged, the seat goes back on the board, and the host gets an urgent in-app alert over the WebSocket.

## Stack

- Browser: HTML, CSS, and ES modules. No build step.
- API: Node.js, Express, and `ws`.
- Database: MySQL 8 or MariaDB 10.11, parameterized SQL, row locks on seat changes.

## Run it locally

1. Create the database and a least-privilege user:

```sql
CREATE DATABASE commutepool CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'commutepool_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-secret';
GRANT SELECT, INSERT, UPDATE, DELETE ON commutepool.* TO 'commutepool_app'@'127.0.0.1';
```

2. Load the schema and seed data:

```bash
mysql -u root -p commutepool < schema.sql
```

3. Configure the API:

```bash
cp server/.env.example server/.env
# Set DB_PASS and SESSION_SECRET (16+ characters).
```

4. Start the server (it also serves the client):

```bash
cd server
npm install
npm start
```

Open the URL printed for `PORT` (3000 by default). In local demo mode, choose a seeded colleague on the sign-in sheet. There is no public registration.

Seeded accounts:

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

Priya’s morning car (about 12 minutes out) already has two riders, which is the easy way to try the 15-minute cancellation warning.

## Production notes

- Set `NODE_ENV=production`, `AUTH_MODE=password` (or put corporate SSO in front of `POST /api/auth/login`), `COOKIE_SECURE=true`, and a long `SESSION_SECRET`.
- Set `DEMO_REFRESH_SCHEDULE=false` so boot does not move seeded departure times.
- `docker compose up -d --build` starts MySQL, the API, and Nginx. Change the default passwords in the compose environment before anyone else can reach the host.
- Session cookies are `HttpOnly` and `SameSite=Lax`. The access cookie lasts 15 minutes and slides while the tab is in use, bounded by an 8-hour refresh cookie. CSRF uses a double-submit `cp_csrf` cookie plus `X-CSRF-Token`.
- Phone numbers and license plates are omitted or masked on the open board. They are returned only to the host and to riders with a confirmed seat.
- Pickup and drop text must be a landmark or society gate. Morning drops and evening pickups must be one of the campus buildings.
- Rides are cancelled in place. Rows are not deleted, so the audit trail stays.

## Checks

```bash
curl -s http://127.0.0.1:3000/api/health
cd server && SMOKE_BASE=http://127.0.0.1:3000 node smoke.mjs
```

`smoke.mjs` covers health, the corporate domain gate, masked phone and plate, private-address rejection, host-only edits, a one-seat race (one `200`, one `409`), the 15-minute late cancel, and the bike’s locked single seat.

## API

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/health` | Process and database status |
| POST | `/api/auth/login` | Sign in with a `@company.com` employee |
| GET | `/api/rides?direction=TO_OFFICE` | Open board |
| POST | `/api/rides` | Publish a ride |
| PUT | `/api/rides/:id` | Host edits a ride |
| DELETE | `/api/rides/:id` | Host cancels a ride |
| POST | `/api/rides/:id/join` | Reserve the last safe seat |
| DELETE | `/api/bookings/:id` | Rider or host releases a seat |
| GET | `/api/notifications` | Alerts for the signed-in employee |
| PATCH | `/api/notifications/:id/read` | Mark an alert read |

Seat changes run in a transaction: `SELECT ... FOR UPDATE` on the ride row, then the booking insert and the conditional seat update. A full ride returns **409**.
