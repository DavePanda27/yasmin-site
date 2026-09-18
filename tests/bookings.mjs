import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker, { flushNotifications } from '../src/worker.js';
import { slots, services, localNow, validDate } from '../src/schedule.js';
import { database } from './d1.mjs';

let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
const DB = database();
const env = { DB, BOOKINGS_ENABLED: 'true', MAIL_FROM: 'test@example.invalid', BOOKING_EMAIL: 'owner@example.invalid', PUBLIC_ORIGIN: 'https://example.invalid', ASSETS: { fetch: () => new Response('static asset') } };
const tasks = [];
const ctx = { waitUntil(task) { tasks.push(task); } };
let sends = [], failMail = false;
env.EMAIL = { async send(message) { if (failMail) throw new Error('simulated mail outage'); sends.push(message); return { messageId: 'test' }; } };
const day = new Date(); day.setUTCDate(day.getUTCDate() + 2);
const date = day.toISOString().slice(0, 10);
const body = (time = '10:00', service = 'relaks') => ({ service, date, time, name: 'Test klient', phone: '500000000', email: 'test@example.invalid', consent: true, requestId: crypto.randomUUID() });
const request = (path, data, options = {}) => new Request(`https://example.invalid${path}`, { method: data ? 'POST' : 'GET', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...options.headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
const send = (path, data, options) => worker.fetch(request(path, data, options), env, ctx);

check('Warsaw daylight saving time', () => {
  assert.deepEqual(localNow(new Date('2026-07-01T08:00:00Z')), { date: '2026-07-01', minute: 600 });
  assert.deepEqual(localNow(new Date('2026-12-01T09:00:00Z')), { date: '2026-12-01', minute: 600 });
});
check('invalid dates and past days rejected', () => { assert.equal(validDate('2026-02-30'), false); assert.equal(validDate('2020-01-01'), false); });
check('Sunday available, 21:30 closing and 2h notice respected', () => {
  const fixed = new Date('2026-09-18T12:00:00Z');
  assert(slots('2026-09-20', services[0], [], fixed).includes('10:00'));
  assert.equal(slots('2026-09-20', services[0], [], fixed).at(-1), '20:30');
  assert.equal(slots('2026-09-18', services[0], [], fixed)[0], '16:00');
});
check('60 minute buffers checked on both sides', () => {
  const found = slots(date, services[0], [{ booking_time: '13:00', duration_minutes: 90, buffer_minutes: 60 }]);
  assert(found.includes('11:00')); assert(!found.includes('11:30')); assert(!found.includes('15:00')); assert(found.includes('15:30'));
});
let response = await worker.fetch(request('/api/bookings', body()), { ...env, EMAIL: undefined }, ctx);
check('unconfigured email prevents bookings', () => assert.equal(response.status, 503));
response = await send('/api/bookings', body(), { headers: { Origin: 'https://other.invalid' } });
check('cross-origin write rejected', () => assert.equal(response.status, 403));
response = await send('/api/bookings', { ...body(), phone: 'abc' });
check('invalid phone rejected', () => assert.equal(response.status, 400));
response = await send('/api/bookings', { ...body(), website: 'spam' });
check('honeypot rejected', () => assert.equal(response.status, 400));
const first = body();
response = await send('/api/bookings', first);
check('new booking awaits approval', () => assert.equal(response.status, 201));
const publicResult = await response.json();
check('public response contains no approval token', () => { assert.equal(publicResult.status, 'pending'); assert(!JSON.stringify(publicResult).includes('token')); });
await Promise.all(tasks.splice(0));
check('owner notification queued and sent with approval link', () => {
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].to, ['owner@example.invalid']); assert(sends[0].text.includes('/api/approval?token='));
});
response = await send('/api/bookings', first);
check('retry does not duplicate booking or email', () => { assert.equal(response.status, 200); assert.equal(DB.sqlite.prepare('SELECT count(*) n FROM bookings').get().n, 1); assert.equal(sends.length, 1); });
response = await send('/api/bookings', { ...first, time: '18:00' });
check('idempotency key cannot be reused for changed data', () => assert.equal(response.status, 409));
response = await send('/api/bookings', body('11:30'));
check('API prevents booking in required break', () => assert.equal(response.status, 409));
response = await send(`/api/availability?service=relaks&date=${date}`);
const available = await response.json();
check('availability excludes pending visit and its break without leaking contacts', () => { assert(!available.slots.includes('11:30')); assert(available.slots.includes('12:00')); assert.deepEqual(Object.keys(available), ['slots']); });
check('database independently blocks overlapping inserts (race protection)', () => {
  assert.throws(() => DB.sqlite.prepare("INSERT INTO bookings(service,booking_date,booking_time,name,phone,duration_minutes) VALUES ('test',?,'10:30','test','500000000',60)").run(date), /booking_overlap/);
});
let row = DB.sqlite.prepare('SELECT * FROM bookings').get();
response = await send(`/api/approval?token=${row.approval_token}`);
check('email link GET does not approve automatically', () => { assert.equal(response.status, 200); assert.equal(DB.sqlite.prepare('SELECT status FROM bookings').get().status, 'pending'); });
const approvalPost = decision => new Request(`https://example.invalid/api/approval?token=${row.approval_token}`, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}` });
response = await worker.fetch(approvalPost('cancelled'), env, ctx);
check('rejection releases slot and consumes token', () => { assert.equal(response.status, 200); assert.equal(DB.sqlite.prepare('SELECT status FROM bookings').get().status, 'cancelled'); });
response = await worker.fetch(approvalPost('confirmed'), env, ctx);
check('used approval token cannot be replayed', () => assert.equal(response.status, 404));
response = await send('/api/bookings', body());
check('cancelled exact start can be booked again', () => assert.equal(response.status, 201));
await Promise.all(tasks.splice(0));
row = DB.sqlite.prepare("SELECT * FROM bookings WHERE status='pending'").get();
response = await worker.fetch(approvalPost('confirmed'), env, ctx);
check('approval confirms selected booking', () => { assert.equal(response.status, 200); assert.equal(DB.sqlite.prepare('SELECT status FROM bookings WHERE id=?').get(row.id).status, 'confirmed'); });

failMail = true;
response = await send('/api/bookings', body('16:00'));
await Promise.all(tasks.splice(0));
check('email failure retains pending booking for retry', () => { assert.equal(response.status, 201); assert.equal(DB.sqlite.prepare("SELECT notification_state FROM bookings WHERE booking_time='16:00'").get().notification_state, 'pending'); });
failMail = false;
await flushNotifications(env);
check('scheduled retry delivers notification', () => assert.equal(DB.sqlite.prepare("SELECT notification_state FROM bookings WHERE booking_time='16:00'").get().notification_state, 'sent'));
await send('/api/bookings', body('10:30'));
response = await send('/api/bookings', body('18:00'));
check('rate limit caps repeated submissions', () => assert.equal(response.status, 429));
response = await send('/api/bookings');
check('no public customer list', () => assert.equal(response.status, 405));
response = await send('/index.html');
check('static content delegated to assets binding', () => assert.equal(response.status, 200));

const old = database("CREATE TABLE bookings(id INTEGER PRIMARY KEY AUTOINCREMENT,service TEXT NOT NULL,booking_date TEXT NOT NULL,booking_time TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT,status TEXT NOT NULL DEFAULT 'confirmed',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(booking_date,booking_time)); INSERT INTO bookings(service,booking_date,booking_time,name,phone) VALUES ('Plecy i kręgosłup','2026-10-01','10:00','Existing','500000000');");
check('migration preserves existing record and backup', () => { const row = old.sqlite.prepare('SELECT * FROM bookings').get(); assert.equal(row.name, 'Existing'); assert.equal(row.duration_minutes, 50); assert.equal(old.sqlite.prepare('SELECT count(*) n FROM bookings_legacy').get().n, 1); });
check('staged assets contain no backend or private configuration', () => {
  assert.deepEqual(readdirSync('.site').sort(), ['404.html','assets','booking.css','booking.js','index.html','robots.txt']);
  assert.equal(readFileSync('.site/index.html', 'utf8'), readFileSync('index.html', 'utf8'));
});
console.log(`\n${checks} checks passed. Real SQLite; simulated D1 adapter and email delivery. No production calls.`);

