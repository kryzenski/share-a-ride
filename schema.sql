-- CommutePool / Share-A-Ride
-- Relational schema for MySQL 8 and MariaDB 10.11.
-- All DATETIME values are stored in UTC.
--
--   mysql -u root -p -e "CREATE DATABASE commutepool CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
--   mysql -u root -p commutepool < schema.sql

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS commutepool
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE commutepool;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS ride_bookings;
DROP TABLE IF EXISTS rides;
DROP TABLE IF EXISTS employees;
SET FOREIGN_KEY_CHECKS = 1;

-- ========================================================
-- 1. EMPLOYEES
-- Closed directory. Public registration is not permitted.
-- ========================================================
CREATE TABLE employees (
    employee_id VARCHAR(50) PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(120) NOT NULL,
    department VARCHAR(80) NOT NULL,
    phone_number VARCHAR(25) NOT NULL,
    role ENUM('RIDER', 'HOST', 'ADMIN') NOT NULL DEFAULT 'RIDER',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_employees_email (email),
    CONSTRAINT chk_email_domain CHECK (email LIKE '%@company.com')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================================
-- 2. RIDES
-- available_seats is the source of truth for the open board.
-- ========================================================
CREATE TABLE rides (
    ride_id INT AUTO_INCREMENT PRIMARY KEY,
    host_id VARCHAR(50) NOT NULL,
    direction ENUM('TO_OFFICE', 'FROM_OFFICE') NOT NULL,
    vehicle_type ENUM('CAR', 'BIKE', 'UBER_AUTO', 'RAPIDO_AUTO') NOT NULL,
    vehicle_details VARCHAR(150) NOT NULL,
    vehicle_model VARCHAR(80) NULL,
    license_plate VARCHAR(20) NULL,
    total_seats INT NOT NULL,
    available_seats INT NOT NULL,
    departure_time DATETIME NOT NULL,
    pickup_location VARCHAR(255) NOT NULL,
    drop_location VARCHAR(255) NOT NULL,
    route_notes VARCHAR(500) NULL,
    status ENUM('OPEN', 'FULL', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_rides_host FOREIGN KEY (host_id) REFERENCES employees (employee_id) ON DELETE CASCADE,
    CONSTRAINT chk_seats CHECK (available_seats >= 0 AND available_seats <= total_seats),
    CONSTRAINT chk_total_seats CHECK (total_seats BETWEEN 1 AND 4),
    CONSTRAINT chk_bike_seats CHECK (vehicle_type <> 'BIKE' OR total_seats = 1),
    CONSTRAINT chk_auto_seats CHECK (
        vehicle_type NOT IN ('UBER_AUTO', 'RAPIDO_AUTO') OR total_seats BETWEEN 2 AND 3
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================================
-- 3. RIDE BOOKINGS
-- active_slot is unique only while a reservation is CONFIRMED,
-- so a cancelled rider can book again without losing the audit row.
-- ========================================================
CREATE TABLE ride_bookings (
    booking_id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    rider_id VARCHAR(50) NOT NULL,
    booking_status ENUM('CONFIRMED', 'CANCELLED') NOT NULL DEFAULT 'CONFIRMED',
    booked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at DATETIME NULL,
    is_late_cancellation BOOLEAN NOT NULL DEFAULT FALSE,
    active_slot VARCHAR(120) GENERATED ALWAYS AS (
        CASE
            WHEN booking_status = 'CONFIRMED' THEN CONCAT(ride_id, ':', rider_id)
            ELSE NULL
        END
    ) STORED,
    CONSTRAINT fk_bookings_ride FOREIGN KEY (ride_id) REFERENCES rides (ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_bookings_rider FOREIGN KEY (rider_id) REFERENCES employees (employee_id) ON DELETE CASCADE,
    UNIQUE KEY uq_active_booking (active_slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================================
-- 4. NOTIFICATIONS
-- Urgent rows are the 15-minute late-cancellation alerts.
-- ========================================================
CREATE TABLE notifications (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    recipient_id VARCHAR(50) NOT NULL,
    ride_id INT NOT NULL,
    title VARCHAR(120) NOT NULL,
    message TEXT NOT NULL,
    urgency ENUM('NORMAL', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_recipient FOREIGN KEY (recipient_id) REFERENCES employees (employee_id) ON DELETE CASCADE,
    CONSTRAINT fk_notifications_ride FOREIGN KEY (ride_id) REFERENCES rides (ride_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rides_lookup ON rides (direction, departure_time, status);
CREATE INDEX idx_rides_host ON rides (host_id, departure_time);
CREATE INDEX idx_bookings_lookup ON ride_bookings (ride_id, rider_id, booking_status);
CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, is_read, created_at);

-- ========================================================
-- SEED: employees
-- ========================================================
INSERT INTO employees (employee_id, full_name, email, department, phone_number, role) VALUES
('EMP001', 'Aditi Rao', 'aditi.rao@company.com', 'Engineering', '+91 98765 43210', 'HOST'),
('EMP002', 'Rohan Verma', 'rohan.verma@company.com', 'Design', '+91 98765 12345', 'HOST'),
('EMP003', 'Sara Fernandes', 'sara.fernandes@company.com', 'HR', '+91 98111 22003', 'RIDER'),
('EMP004', 'Vikram Iyer', 'vikram.iyer@company.com', 'Marketing', '+91 98450 11882', 'RIDER'),
('EMP005', 'Neha Kapoor', 'neha.kapoor@company.com', 'Engineering', '+91 99001 44221', 'HOST'),
('EMP006', 'Imran Shah', 'imran.shah@company.com', 'Finance', '+91 98860 33445', 'HOST'),
('EMP007', 'Priya Nair', 'priya.nair@company.com', 'Product', '+91 97311 55667', 'HOST'),
('EMP008', 'Kabir Mehta', 'kabir.mehta@company.com', 'Operations', '+91 96201 77889', 'ADMIN');

-- ========================================================
-- SEED: rides
-- route_notes prefixed with "seed:" so local boot can slide
-- departure times forward without touching real offers.
-- The prefix is stripped before display.
-- ========================================================
INSERT INTO rides (
    ride_id, host_id, direction, vehicle_type, vehicle_details, vehicle_model, license_plate,
    total_seats, available_seats, departure_time, pickup_location, drop_location, route_notes, status
) VALUES
(
    1, 'EMP001', 'TO_OFFICE', 'CAR', 'Hyundai i20 (KA-03-HA-4411)', 'Hyundai i20', 'KA-03-HA-4411',
    3, 2, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 45 MINUTE),
    'Indiranagar Metro', 'Campus HQ Tower B',
    'seed: Leaving from the metro pillar nearest the ticket hall.', 'OPEN'
),
(
    2, 'EMP002', 'TO_OFFICE', 'UBER_AUTO', 'Uber Auto (Booking Initiator)', 'Uber Auto', NULL,
    2, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE),
    'HSR Layout 27th Main', 'Campus HQ Gate 1',
    'seed: Auto will start once both seats are filled.', 'OPEN'
),
(
    3, 'EMP003', 'TO_OFFICE', 'BIKE', 'TVS Jupiter (KA-05-JK-2291)', 'TVS Jupiter', 'KA-05-JK-2291',
    1, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 80 MINUTE),
    'Koramangala Sony Signal', 'Campus HQ Tech Park Gate 2',
    'seed: Will wait near Tech Park Gate 2 for 5 minutes.', 'OPEN'
),
(
    4, 'EMP005', 'FROM_OFFICE', 'CAR', 'Honda City (KA-01-NE-9088)', 'Honda City', 'KA-01-NE-9088',
    4, 2, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR),
    'Campus HQ Tower B', 'Green Glen Layout Gate 2',
    'seed: Dropping along the outer ring, society gate only.', 'OPEN'
),
(
    5, 'EMP006', 'FROM_OFFICE', 'RAPIDO_AUTO', 'Rapido Auto (Booking Initiator)', 'Rapido Auto', NULL,
    3, 3, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR),
    'Campus HQ Gate 1', 'Jayanagar 4th Block Signal',
    'seed: Rapido Auto split three ways.', 'OPEN'
),
(
    6, 'EMP007', 'TO_OFFICE', 'CAR', 'Tata Nexon (KA-05-PR-2210)', 'Tata Nexon', 'KA-05-PR-2210',
    3, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 MINUTE),
    'Bellandur Central Mall Gate', 'Campus HQ Tower B',
    'seed: Tight morning window. Please be at the mall gate.', 'OPEN'
),
(
    7, 'EMP008', 'TO_OFFICE', 'CAR', 'Mahindra XUV700 (KA-03-KB-1008)', 'Mahindra XUV700', 'KA-03-KB-1008',
    4, 0, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 HOUR),
    'Whitefield Forum Mall Gate', 'Campus HQ Tower B',
    'seed: Car is full right now. Check back if someone drops.', 'FULL'
),
(
    8, 'EMP004', 'FROM_OFFICE', 'CAR', 'Kia Seltos (KA-02-VI-7741)', 'Kia Seltos', 'KA-02-VI-7741',
    3, 2, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 HOUR),
    'Campus HQ Tech Park Gate 2', 'Indiranagar 100 Feet Road',
    'seed: Evening drop toward Indiranagar. Landmark only.', 'OPEN'
);

INSERT INTO ride_bookings (ride_id, rider_id, booking_status) VALUES
(1, 'EMP003', 'CONFIRMED'),
(2, 'EMP004', 'CONFIRMED'),
(4, 'EMP001', 'CONFIRMED'),
(4, 'EMP008', 'CONFIRMED'),
(6, 'EMP004', 'CONFIRMED'),
(6, 'EMP008', 'CONFIRMED'),
(7, 'EMP001', 'CONFIRMED'),
(7, 'EMP002', 'CONFIRMED'),
(7, 'EMP003', 'CONFIRMED'),
(7, 'EMP005', 'CONFIRMED'),
(8, 'EMP007', 'CONFIRMED');

INSERT INTO notifications (recipient_id, ride_id, title, message, urgency, is_read) VALUES
(
    'EMP001', 1,
    'Pickup note from Sara',
    'Sara Fernandes is confirmed from Indiranagar Metro and will wait by the ticket hall pillar.',
    'NORMAL', FALSE
);

ALTER TABLE rides AUTO_INCREMENT = 100;
ALTER TABLE ride_bookings AUTO_INCREMENT = 100;
ALTER TABLE notifications AUTO_INCREMENT = 100;
