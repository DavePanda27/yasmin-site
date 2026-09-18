-- Compatible with the bookings schema from the original project conversation.
-- Existing bookings are preserved, including a backup table; verify remote schema before applying.
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL,
 booking_date TEXT NOT NULL, booking_time TEXT NOT NULL,
 name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
 status TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(booking_date, booking_time)
);
ALTER TABLE bookings RENAME TO bookings_legacy;
CREATE TABLE bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL,
 booking_date TEXT NOT NULL, booking_time TEXT NOT NULL,
 name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
 buffer_minutes INTEGER NOT NULL DEFAULT 60 CHECK(buffer_minutes >= 0),
 request_id TEXT UNIQUE, approval_token TEXT UNIQUE,
 notification_state TEXT NOT NULL DEFAULT 'pending',
 notification_attempts INTEGER NOT NULL DEFAULT 0,
 notification_claim_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bookings (id,service,booking_date,booking_time,name,phone,email,status,created_at,duration_minutes,notification_state)
SELECT id,service,booking_date,booking_time,name,phone,email,status,created_at,
 CASE service WHEN 'Masaż relaksacyjny' THEN 60 WHEN 'Plecy i kręgosłup' THEN 50
 WHEN 'Masaż leczniczy' THEN 60 WHEN 'Kark i szyja' THEN 30 ELSE 90 END, 'legacy'
FROM bookings_legacy;
CREATE INDEX bookings_day ON bookings(booking_date,status);
CREATE TRIGGER bookings_no_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status IN ('pending','confirmed')
BEGIN
 SELECT RAISE(ABORT,'booking_overlap') WHERE EXISTS (
 SELECT 1 FROM bookings b WHERE b.booking_date=NEW.booking_date AND b.status IN ('pending','confirmed')
 AND (CAST(substr(NEW.booking_time,1,2) AS INTEGER)*60+CAST(substr(NEW.booking_time,4,2) AS INTEGER)) <
 (CAST(substr(b.booking_time,1,2) AS INTEGER)*60+CAST(substr(b.booking_time,4,2) AS INTEGER)+b.duration_minutes+b.buffer_minutes)
 AND (CAST(substr(NEW.booking_time,1,2) AS INTEGER)*60+CAST(substr(NEW.booking_time,4,2) AS INTEGER)+NEW.duration_minutes+NEW.buffer_minutes) >
 (CAST(substr(b.booking_time,1,2) AS INTEGER)*60+CAST(substr(b.booking_time,4,2) AS INTEGER)));
END;
CREATE TRIGGER bookings_no_overlap_update BEFORE UPDATE OF booking_date,booking_time,duration_minutes,buffer_minutes,status ON bookings
WHEN NEW.status IN ('pending','confirmed')
BEGIN
 SELECT RAISE(ABORT,'booking_overlap') WHERE EXISTS (
 SELECT 1 FROM bookings b WHERE b.id<>NEW.id AND b.booking_date=NEW.booking_date AND b.status IN ('pending','confirmed')
 AND (CAST(substr(NEW.booking_time,1,2) AS INTEGER)*60+CAST(substr(NEW.booking_time,4,2) AS INTEGER)) <
 (CAST(substr(b.booking_time,1,2) AS INTEGER)*60+CAST(substr(b.booking_time,4,2) AS INTEGER)+b.duration_minutes+b.buffer_minutes)
 AND (CAST(substr(NEW.booking_time,1,2) AS INTEGER)*60+CAST(substr(NEW.booking_time,4,2) AS INTEGER)+NEW.duration_minutes+NEW.buffer_minutes) >
 (CAST(substr(b.booking_time,1,2) AS INTEGER)*60+CAST(substr(b.booking_time,4,2) AS INTEGER)));
END;
CREATE TABLE booking_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);

