// Local fallback preview when Wrangler cannot launch on the host.
// Runs actual Worker handlers with SQLite; email delivery is simulated, never sent.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import worker from '../src/worker.js';
import { database } from '../tests/d1.mjs';
const root = resolve('.site');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
const EMAIL = { async send() {
  console.log('LOCAL PREVIEW: notification simulated; no email sent.');
  return { messageId: 'preview-only' };
} };
const env = { DB: database(), EMAIL, BOOKINGS_ENABLED: 'true', MAIL_FROM: 'preview@example.invalid', BOOKING_EMAIL: 'preview@example.invalid', PUBLIC_ORIGIN: 'http://127.0.0.1:8787', ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  const permitted = path === '/' || ['/index.html','/404.html','/robots.txt','/booking.js','/booking.css'].includes(path) || /^\/assets\/images\/[a-z0-9-]+\.webp$/.test(path);
  if (!permitted) return new Response(await readFile(resolve(root, '404.html')), { status: 404, headers: { 'Content-Type': types['.html'] } });
  const file = resolve(root, path === '/' ? 'index.html' : path.slice(1));
  try { return new Response(await readFile(file), { headers: { 'Content-Type': types[extname(file)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
}} };
createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const request = new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers: req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
    const response = await worker.fetch(request, env, { waitUntil: promise => promise.catch(() => console.error('Preview background failure')) });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('Preview error'); }
}).listen(8787, '127.0.0.1', () => console.log('LOCAL PREVIEW http://127.0.0.1:8787 — in-memory SQLite, simulated mail, no production writes.'));

