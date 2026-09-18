// Run only against the isolated authenticated test Worker, never production.
import assert from 'node:assert/strict';
const origin = 'https://yasmin-bookings-check.dawtylu.workers.dev';
const token = process.env.YASMIN_TEST_TOKEN;
if (!token) throw new Error('YASMIN_TEST_TOKEN required');
const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
let response = await fetch(`${origin}/api/services`, { headers });
assert.equal(response.status, 200);
assert.equal((await response.json()).enabled, true);
console.log('PASS Cloudflare Worker loads service catalog');
const body = { service: 'relaks', date, time: '10:00', name: 'TEST INTEGRACJI', phone: '500000000', email: 'test@example.invalid', consent: true };
const attempts = Array.from({ length: 3 }, () => ({ ...body, requestId: crypto.randomUUID() }));
const responses = await Promise.all(attempts.map(b => fetch(`${origin}/api/bookings`, { method: 'POST', headers, body: JSON.stringify(b) })));
assert.deepEqual(responses.map(r => r.status).sort(), [201, 409, 409]);
console.log('PASS three concurrent requests: one booking, two conflicts');
const winner = attempts[responses.findIndex(r => r.status === 201)];
response = await fetch(`${origin}/api/bookings`, { method: 'POST', headers, body: JSON.stringify(winner) });
assert.equal(response.status, 200);
console.log('PASS network retry does not duplicate booking');
response = await fetch(`${origin}/api/availability?date=${date}&service=relaks`, { headers });
const availability = await response.json();
assert(!availability.slots.includes('11:30')); assert(availability.slots.includes('12:00'));
console.log('PASS live D1 availability respects visit and 60 minute buffer');
response = await fetch(`${origin}/api/bookings`, { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body: JSON.stringify(body) });
assert.equal(response.status, 403);
console.log('PASS cross-origin requests rejected');
console.log('Cloud checks passed; only isolated test database modified.');

