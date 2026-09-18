import { services, schedule, slots, validDate, localNow } from './schedule.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, { status, headers });
const error = (message, status = 400) => json({ error: message }, status);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const configured = env => !!(env.BOOKINGS_ENABLED === 'true' && env.EMAIL?.send && env.MAIL_FROM && env.BOOKING_EMAIL && env.PUBLIC_ORIGIN);
const activeBookings = async (env, date) => (await env.DB.prepare(
  "SELECT booking_time,duration_minutes,buffer_minutes FROM bookings WHERE booking_date=? AND status IN ('pending','confirmed')"
).bind(date).all()).results;

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new Error('invalid_body'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function notify(env, booking) {
  if (!configured(env) || booking.notification_state !== 'pending') return;
  const claim = await env.DB.prepare("UPDATE bookings SET notification_claim_until=? WHERE id=? AND notification_state='pending' AND notification_claim_until<? RETURNING id")
    .bind(Date.now() + 60000, booking.id, Date.now()).first();
  if (!claim) return;
  const link = `${env.PUBLIC_ORIGIN}/api/approval?token=${encodeURIComponent(booking.approval_token)}`;
  const text = `Nowe zgłoszenie rezerwacji — Yasmin\n\n${booking.service}\n${booking.booking_date}, ${booking.booking_time}\nCzas: ${booking.duration_minutes} min + ${booking.buffer_minutes} min przerwy\nImię: ${booking.name}\nTelefon: ${booking.phone}\nE-mail: ${booking.email || 'nie podano'}\n\nTermin jest wstępnie zajęty. Otwórz stronę i zatwierdź albo odrzuć zgłoszenie:\n${link}\n\nPo decyzji skontaktuj się z klientem telefonicznie. System nie wysyła jeszcze wiadomości do klienta.`;
  try {
    await env.EMAIL.send({ from: env.MAIL_FROM, to: [env.BOOKING_EMAIL], subject: `Yasmin: rezerwacja ${booking.booking_date} ${booking.booking_time}`, text });
    await env.DB.prepare("UPDATE bookings SET notification_state='sent',notification_attempts=notification_attempts+1 WHERE id=?").bind(booking.id).run();
  } catch {
    // Do not log contact details, tokens or provider responses. Keep the reservation for retry.
    await env.DB.prepare("UPDATE bookings SET notification_claim_until=0,notification_attempts=notification_attempts+1,notification_state=CASE WHEN notification_attempts>=11 THEN 'failed' ELSE 'pending' END WHERE id=? AND notification_state='pending'").bind(booking.id).run();
    console.error('Booking notification failed; reservation retained for review/retry.');
  }
}

export async function flushNotifications(env) {
  const pending = await env.DB.prepare("SELECT * FROM bookings WHERE notification_state='pending' AND status='pending' AND booking_date>=? ORDER BY id LIMIT 20").bind(localNow().date).all();
  for (const booking of pending.results) await notify(env, booking);
  await env.DB.prepare('DELETE FROM booking_rate_limits WHERE expires < ?').bind(Date.now()).run();
}

async function createBooking(request, env, ctx) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return error('Niedozwolone źródło żądania.', 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return error('Wymagany format JSON.', 415);
  if (!configured(env)) return error('Zapisy online są chwilowo niedostępne. Zadzwoń: 697 946 177.', 503);
  let body;
  try { body = JSON.parse(await readBody(request)); } catch { return error('Nieprawidłowe dane formularza.'); }
  if (!body || typeof body !== 'object') return error('Nieprawidłowe dane formularza.');
  const { service: serviceId, date, time, requestId } = body;
  const service = services.find(s => s.id === serviceId);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.replace(/[\s()-]/g, '') : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (body.website || body.consent !== true || !service || typeof date !== 'string' || !validDate(date) ||
      typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time) || name.length < 2 || name.length > 100 ||
      /[\r\n\x00-\x1f]/.test(name) || !/^\+?\d{9,15}$/.test(phone) ||
      email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) return error('Sprawdź usługę, termin oraz dane kontaktowe.');
  const existing = await env.DB.prepare('SELECT * FROM bookings WHERE request_id=?').bind(requestId).first();
  if (existing) {
    if (existing.service !== service.name || existing.booking_date !== date || existing.booking_time !== time ||
        existing.name !== name || existing.phone !== phone || (existing.email || '') !== email) return error('Odśwież formularz przed kolejnym zgłoszeniem.', 409);
    return json({ status: existing.status, message: 'Zgłoszenie zostało już zapisane.' });
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const hour = Math.floor(Date.now() / 3600000);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${hour}:${ip}`));
  const key = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  const rate = await env.DB.prepare('INSERT INTO booking_rate_limits(key,attempts,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key, (hour + 2) * 3600000).first();
  if (rate.attempts > 5) return error('Zbyt wiele prób. Spróbuj później lub zadzwoń.', 429);
  if (!slots(date, service, await activeBookings(env, date)).includes(time)) return error('Ten termin jest już niedostępny. Wybierz inny.', 409);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
  let booking;
  try {
    booking = await env.DB.prepare("INSERT INTO bookings(service,booking_date,booking_time,name,phone,email,status,duration_minutes,buffer_minutes,request_id,approval_token) VALUES (?,?,?,?,?,?,'pending',?,?,?,?) RETURNING *")
      .bind(service.name, date, time, name, phone, email || null, service.minutes, schedule.buffer, requestId, token).first();
  } catch (e) {
    if (String(e.message).includes('booking_overlap') || String(e.message).includes('UNIQUE')) return error('Ten termin został właśnie zajęty. Odśwież dostępność.', 409);
    throw e;
  }
  ctx.waitUntil(notify(env, booking));
  return json({ status: 'pending', message: 'Zgłoszenie zapisane. Termin oczekuje na potwierdzenie przez Yasmin. Skontaktujemy się z Tobą telefonicznie.' }, 201);
}

async function approval(request, env, url) {
  const token = url.searchParams.get('token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return error('Nieprawidłowy link.', 404);
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE approval_token=?').bind(token).first();
  if (!booking) return error('Link jest nieprawidłowy lub został już użyty.', 404);
  if (request.method === 'POST') {
    if (request.headers.get('Origin') !== url.origin) return error('Niedozwolone źródło żądania.', 403);
    let data;
    try { data = new URLSearchParams(await readBody(request)); } catch { return error('Nieprawidłowe dane.'); }
    const status = data.get('decision');
    if (!['confirmed', 'cancelled'].includes(status)) return error('Nieprawidłowa decyzja.');
    const now = localNow();
    if (booking.booking_date < now.date || (booking.booking_date === now.date && booking.booking_time <= `${String(Math.floor(now.minute / 60)).padStart(2, '0')}:${String(now.minute % 60).padStart(2, '0')}`)) return error('Termin już minął.', 409);
    const result = await env.DB.prepare("UPDATE bookings SET status=?,approval_token=NULL WHERE id=? AND status='pending' AND approval_token=?").bind(status, booking.id, token).run();
    if (!result.meta.changes) return error('Zgłoszenie zostało już rozpatrzone.', 409);
    return page('Decyzja zapisana', `<p>${status === 'confirmed' ? 'Rezerwacja potwierdzona.' : 'Zgłoszenie odrzucone, termin jest ponownie wolny.'}</p><p>Powiadom klienta telefonicznie: <a href="tel:${escape(booking.phone)}">${escape(booking.phone)}</a>.</p>`);
  }
  if (request.method !== 'GET') return error('Niedozwolona metoda.', 405);
  return page('Zgłoszenie rezerwacji', `<p>${escape(booking.service)} — ${escape(booking.booking_date)}, ${escape(booking.booking_time)}</p><p>${escape(booking.name)}<br>Telefon: ${escape(booking.phone)}<br>E-mail: ${escape(booking.email || 'nie podano')}</p><p>Po decyzji powiadom klienta telefonicznie.</p><form method="post"><button name="decision" value="confirmed">Potwierdź rezerwację</button> <button name="decision" value="cancelled">Odrzuć i zwolnij termin</button></form>`);
}

function page(title, content) {
  return new Response(`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} — Yasmin</title><link rel="stylesheet" href="/booking.css"><main class="approval"><h1>${title}</h1>${content}</main></html>`, {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/services' && request.method === 'GET') return json({ services, schedule, enabled: configured(env), today: localNow().date });
      if (url.pathname === '/api/availability' && request.method === 'GET') {
        const service = services.find(s => s.id === url.searchParams.get('service'));
        const date = url.searchParams.get('date') || '';
        if (!service || !validDate(date)) return error('Wybierz poprawną usługę i datę (do 60 dni naprzód).');
        if (!configured(env)) return error('Zapisy online są chwilowo niedostępne. Zadzwoń: 697 946 177.', 503);
        return json({ slots: slots(date, service, await activeBookings(env, date)) });
      }
      if (url.pathname === '/api/bookings') return request.method === 'POST' ? await createBooking(request, env, ctx) : error('Niedozwolona metoda.', 405);
      if (url.pathname === '/api/approval') return await approval(request, env, url);
      return error('Nie znaleziono.', 404);
    } catch {
      console.error('Booking API unavailable.');
      return error('Nie udało się obsłużyć żądania. Spróbuj ponownie lub zadzwoń: 697 946 177.', 503);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(flushNotifications(env)); }
};

