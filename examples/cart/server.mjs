import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const origin = `http://127.0.0.1:${port}`;
const brokenDiscount = process.env.JOURNEYPROOF_BROKEN_DISCOUNT === '1';
const products = [
  { id: 'notebook', name: 'Field notebook', priceCents: 4000 },
  { id: 'bag', name: 'Canvas bag', priceCents: 6000 },
];
const sessions = new Map();
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
].map(async ([route, file, type]) => [route, { body: await readFile(new URL(file, import.meta.url)), type }])));

function cartFor(req, res) {
  let id = /(?:^|;\s*)journeyproof_cart=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  if (!id || !sessions.has(id)) {
    id = randomUUID();
    sessions.set(id, { quantities: {}, coupon: '', error: '', touched: Date.now() });
    res.setHeader('Set-Cookie', `journeyproof_cart=${id}; Path=/; HttpOnly; SameSite=Strict`);
  }
  const cart = sessions.get(id);
  cart.touched = Date.now();
  return cart;
}

function snapshot(cart) {
  const items = products.filter(p => cart.quantities[p.id]).map(p => ({ ...p, quantity: cart.quantities[p.id] }));
  const subtotalCents = items.reduce((sum, p) => sum + p.priceCents * p.quantity, 0);
  // Integer cents and integer basis points; round the discount once per order.
  const basisPoints = cart.coupon === 'SAVE10' ? (brokenDiscount ? 500 : 1000) : 0;
  const discountCents = Math.round(subtotalCents * basisPoints / 10000);
  return { products, items, subtotalCents, discountCents, totalCents: subtotalCents - discountCents,
    coupon: cart.coupon, error: cart.error };
}

function update(cart, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a cart action.');
  const { action, productId, quantity } = input;
  if (['add', 'quantity', 'remove'].includes(action)) {
    if (!products.some(p => p.id === productId)) throw new Error('Unknown product.');
    const next = action === 'add' ? (cart.quantities[productId] ?? 0) + 1 : action === 'remove' ? 0 : quantity;
    if (!Number.isInteger(next) || next < 0 || next > 99) throw new Error('Quantity must be an integer from 0 to 99.');
    if (next === 0) delete cart.quantities[productId];
    else cart.quantities[productId] = next;
  } else if (action === 'coupon') {
    if (typeof input.code !== 'string' || input.code.length > 64) throw new Error('Enter a coupon code of at most 64 characters.');
    const code = input.code.trim().toUpperCase();
    cart.coupon = code === 'SAVE10' ? code : '';
    cart.error = code === 'SAVE10' ? '' : code === 'EXPIRED' ? 'Coupon EXPIRED has expired. No discount applied.'
      : code ? `Coupon ${code} is invalid. No discount applied.` : 'Enter a coupon code. No discount applied.';
  } else if (action === 'reset') {
    cart.quantities = {};
    cart.coupon = '';
    cart.error = '';
  } else throw new Error('Unknown cart action.');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && assets.has(pathname)) {
      const asset = assets.get(pathname);
      // Establish the cookie before the browser can issue concurrent cart requests.
      if (pathname === '/') cartFor(req, res);
      res.writeHead(200, { 'Content-Type': asset.type });
      return res.end(asset.body);
    }
    if (pathname !== '/api/cart') return json(res, 404, { error: 'Not found.' });
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'Use application/json.' });
    }
    const cart = cartFor(req, res);
    if (req.method === 'POST') {
      let body = '';
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return json(res, 413, { error: 'Request too large.' });
        body += chunk;
      }
      update(cart, JSON.parse(body));
    }
    json(res, 200, snapshot(cart));
  } catch (error) {
    json(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message });
  }
});

// Disposable demo sessions expire after two hours of inactivity and on restart.
const sweep = setInterval(() => {
  for (const [id, cart] of sessions) if (Date.now() - cart.touched > 2 * 60 * 60 * 1000) sessions.delete(id);
}, 60_000).unref();
server.on('error', error => { console.error(`Cart server: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`JourneyProof cart ready at ${origin}${brokenDiscount ? ' (deliberately broken discount)' : ''}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(sweep);
  server.close();
  server.closeIdleConnections();
});
