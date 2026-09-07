import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BrowserRecorder } from '../src/core/recorder.js';
import type { InteractionEvent } from '../src/shared/types.js';

let server: Server;
let origin: string;
const document = `<!doctype html><html><body>
  <label for="title">Title</label><input id="title" data-testid="title" name="title">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="token">API token</label><input id="token" name="api_token">
  <label for="card">Card number</label><input id="card" autocomplete="cc-number">
  <label for="agree">Agree</label><input id="agree" type="checkbox">
  <label for="color">Color</label><select id="color"><option value="red">Red</option><option value="blue">Blue</option></select>
  <button data-testid="save" onclick="document.querySelector('#result').textContent='Saved'">Save</button>
  <p id="result"></p><a id="next" href="/next?token=navigation-secret#private">Continue</a>
  <a id="popup" href="/popup?token=popup-secret#private" target="_blank">Open popup</a>
  <button id="spa" onclick="history.pushState({}, '', '/spa?token=spa-secret#private')">SPA</button>
  <input id="upload" type="file"><canvas id="canvas" width="100" height="100"></canvas>
  <div id="drag" draggable="true">Drag item</div><div id="drop">Drop here</div>
  <span data-sensitive>Visible private account data</span>
</body></html>`;

before(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith('/hang')) return;
    if (request.url?.startsWith('/api')) {
      response.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=cookie-secret', 'X-Private': 'header-secret' });
      response.end(JSON.stringify({ secret: 'response-body-secret' })); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(document);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function fixture(screenshots = false) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'journeyproof-recorder-'));
  const observed: InteractionEvent[] = [];
  const warnings: string[] = [];
  const recorder = new BrowserRecorder({ artifactDir, onEvent: (event) => observed.push(event), onWarning: (warning) => warnings.push(warning) });
  await recorder.start(`${origin}/?token=start-secret#private`, { headless: true, captureScreenshots: screenshots });
  return { recorder, artifactDir, observed, warnings, cleanup: async () => { await recorder.stop(); await rm(artifactDir, { recursive: true, force: true }); } };
}

test('real browser coalesces typing and records click, select, check and semantic press in order', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.getByLabel('Title', { exact: true }).click();
    await page.getByLabel('Title', { exact: true }).pressSequentially('Journey');
    await page.getByTestId('save').click();
    assert.equal(await page.locator('#result').textContent(), 'Saved');
    await page.getByLabel('Agree', { exact: true }).check();
    await page.getByLabel('Agree', { exact: true }).uncheck();
    // Native keyboard selection emits trusted DOM events, unlike selectOption().
    await page.getByLabel('Color', { exact: true }).focus();
    await page.getByLabel('Color', { exact: true }).press('b');
    await page.getByLabel('Title', { exact: true }).fill('Final title');
    await page.getByLabel('Title', { exact: true }).press('Tab');
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.map((event) => event.action), ['navigate', 'fill', 'click', 'check', 'uncheck', 'select', 'fill', 'press']);
    assert.equal(result.events[1].value, 'Journey');
    assert.deepEqual(result.events[1].locators.map((locator) => locator.strategy), ['testId', 'role', 'label', 'css']);
    assert.equal(result.events[5].value, 'blue');
    assert.equal(result.events[7].value, 'Tab');
    assert.deepEqual(result.events.map((event) => event.sequence), result.events.map((_, index) => index + 1));
    assert.deepEqual(f.observed, result.events);
    assert.deepEqual(await readdir(f.artifactDir), []);
    assert(result.events.every((event) => !event.screenshot));
    assert(result.events.every((event, index) => !index || event.timestamp >= result.events[index - 1].timestamp));
  } finally { await f.cleanup(); }
});

test('sensitive values are redacted before callback delivery, including the final unblurred edit', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.locator('#password').pressSequentially('password-super-secret');
    await page.locator('#email').fill('person@example.test');
    await page.locator('#token').fill('token-super-secret');
    await page.locator('#card').fill('4111111111111111');
    const result = await f.recorder.stop();
    const fills = result.events.filter((event) => event.action === 'fill');
    assert.equal(fills.length, 4);
    assert(fills.every((event) => event.redacted && event.value === '[REDACTED]'));
    for (const secret of ['password-super-secret', 'person@example.test', 'token-super-secret', '4111111111111111', 'start-secret']) {
      assert(!JSON.stringify(result).includes(secret), `result leaked ${secret}`);
      assert(!JSON.stringify(f.observed).includes(secret), `callback leaked ${secret}`);
    }
  } finally { await f.cleanup(); }
});

test('navigation and request ledger preserve order and strip query, fragment and authentication', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.evaluate(async () => {
      await fetch('/api?token=request-secret', { method: 'POST', headers: { 'X-Secret': 'request-header-secret' }, body: 'request-body-secret' });
    });
    await page.locator('#title').fill('Before navigation');
    await page.locator('#next').click();
    await page.waitForURL('**/next?**');
    await page.locator('#spa').click();
    await page.waitForURL('**/spa?**');
    await page.goto(origin.replace('http://', 'http://user:auth-secret@') + '/authenticated?token=secret#fragment');
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.filter((event) => event.action === 'navigate').map((event) => event.url), [`${origin}/`, `${origin}/next`, `${origin}/spa`, `${origin}/authenticated`]);
    assert.deepEqual(result.events.slice(0, 4).map((event) => event.action), ['navigate', 'fill', 'click', 'navigate']);
    const api = result.network.find((entry) => entry.method === 'POST');
    assert.deepEqual(api, { method: 'POST', url: `${origin}/api`, status: 201 });
    assert(result.network.every((entry) => Object.keys(entry).sort().join(',') === 'method,status,url'));
    assert(result.network.every((entry) => !/[?#@]/.test(entry.url)));
    for (const secret of ['navigation-secret', 'request-secret', 'spa-secret', 'auth-secret', 'user:', 'request-body-secret', 'response-body-secret', 'cookie-secret', 'header-secret']) assert(!JSON.stringify(result).includes(secret), `leaked ${secret}`);
  } finally { await f.cleanup(); }
});

test('popups receive their own page ID and listeners', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#popup').click()]);
    await popup.waitForLoadState();
    await popup.getByTestId('title').fill('Popup title');
    await popup.getByTestId('save').click();
    const result = await f.recorder.stop();
    assert.equal(result.events.filter((event) => event.action === 'popup').length, 1);
    const fill = result.events.find((event) => event.value === 'Popup title');
    assert.equal(fill?.pageId, 'page-2');
    assert(result.events.some((event) => event.action === 'navigate' && event.pageId === 'page-2' && event.url === `${origin}/popup`));
    assert(!JSON.stringify(result).includes('popup-secret'));
  } finally { await f.cleanup(); }
});

test('keyboard button activation is recorded once and later sensitive edits remain distinct', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.locator('#password').fill('first-secret');
    await page.getByTestId('save').focus();
    await page.getByTestId('save').press('Enter');
    await page.locator('#password').fill('second-secret');
    await page.getByTestId('save').focus();
    await page.getByTestId('save').press('Space');
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.map((event) => event.action), ['navigate', 'fill', 'press', 'fill', 'press']);
    assert.deepEqual(result.events.filter((event) => event.action === 'press').map((event) => event.value), ['Enter', 'Space']);
    assert(!JSON.stringify(result).includes('first-secret'));
    assert(!JSON.stringify(result).includes('second-secret'));
  } finally { await f.cleanup(); }
});

test('unsupported uploads, canvas, drag and frames emit explicit warnings', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
    await chooser.setFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('file-body-secret') });
    await page.locator('#canvas').click();
    await page.locator('#drag').dragTo(page.locator('#drop'));
    await page.evaluate(() => { const frame = window.document.createElement('iframe'); frame.srcdoc = '<input id="private">'; window.document.body.append(frame); });
    await page.frameLocator('iframe').locator('#private').fill('frame-secret');
    const result = await f.recorder.stop();
    for (const category of ['File uploads', 'Canvas', 'Drag and drop', 'Frames']) assert(result.warnings.some((warning) => warning.includes(category)), `missing ${category}`);
    assert(!result.events.some((event) => event.action === 'click' && event.locators.some((locator) => locator.value === '#canvas')));
    for (const secret of ['private.txt', 'file-body-secret', 'frame-secret']) assert(!JSON.stringify(result).includes(secret));
    assert(f.warnings.length >= 4);
  } finally { await f.cleanup(); }
});

test('stop flushes pending input, closes the browser, is idempotent and permits a fresh session', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.getByTestId('title').fill('Pending edit');
    await page.evaluate(() => localStorage.setItem('privateSession', 'must-not-survive'));
    const [first, second] = await Promise.all([f.recorder.stop(), f.recorder.stop()]);
    assert.deepEqual(first, second);
    assert.equal(first.events.at(-1)?.value, 'Pending edit');
    assert(page.isClosed());
    const count = f.observed.length;
    await f.recorder.stop();
    assert.equal(f.observed.length, count);
    await f.recorder.start(origin, { headless: true });
    assert.equal(await f.recorder.page.evaluate(() => localStorage.getItem('privateSession')), null);
    const fresh = await f.recorder.stop();
    assert.equal(fresh.events[0]?.sequence, 1);
    assert(!JSON.stringify(fresh).includes('Pending edit'));
  } finally { await f.cleanup(); }
});

test('recording cancellation interrupts a pending navigation and closes its browser', { timeout: 15_000 }, async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'journeyproof-cancel-'));
  const recorder = new BrowserRecorder({ artifactDir, onEvent: () => {} });
  try {
    const requested = new Promise<void>((resolve) => server.once('request', () => resolve()));
    const starting = recorder.start(`${origin}/hang?token=cancel-secret`, { headless: true });
    const rejection = assert.rejects(starting, /Recording cancelled/);
    await requested;
    const page = recorder.page;
    const startedAt = Date.now();
    const result = await recorder.stop();
    await rejection;
    assert(Date.now() - startedAt < 5_000);
    assert(page.isClosed());
    assert(!JSON.stringify(result).includes('cancel-secret'));
    assert.deepEqual(await recorder.stop(), result);
  } finally { await recorder.stop(); await rm(artifactDir, { recursive: true, force: true }); }
});

test('immediate cancellation during browser launch leaves no active session or late callbacks', { timeout: 15_000 }, async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'journeyproof-cancel-'));
  const events: InteractionEvent[] = [];
  const recorder = new BrowserRecorder({ artifactDir, onEvent: (event) => events.push(event) });
  try {
    const starting = recorder.start(origin, { headless: true });
    const rejected = assert.rejects(starting, /Recording cancelled/);
    const result = await recorder.stop();
    await rejected;
    assert.deepEqual(result.events, []);
    assert.deepEqual(events, []);
    assert.throws(() => recorder.page, /not open/);
    await recorder.start(origin, { headless: true });
    assert.equal((await recorder.stop()).events[0]?.action, 'navigate');
  } finally { await recorder.stop(); await rm(artifactDir, { recursive: true, force: true }); }
});

test('screenshots require opt-in, warn about visible data and mask inputs and marked content', { timeout: 30_000 }, async () => {
  const f = await fixture(true);
  try {
    const page = f.recorder.page;
    // Observe the real screenshot calls while still letting Chromium produce the PNGs.
    const original = page.screenshot.bind(page);
    const masks: string[][] = [];
    page.screenshot = async (options) => {
      masks.push(await options!.mask![0].evaluateAll((elements) => elements.map((el) => el.id || el.getAttribute('data-sensitive') || el.localName)));
      return original(options);
    };
    await page.locator('#password').fill('screenshot-secret');
    await page.getByTestId('save').click();
    const result = await f.recorder.stop();
    assert(result.warnings.some((warning) => warning.includes('may still contain visible data')));
    assert(masks.length > 0);
    assert(masks.every((ids) => ['title', 'password', 'email', 'token', 'card', 'agree', 'color', 'upload', 'canvas', 'span'].every((id) => ids.includes(id))));
    const screenshots = result.events.filter((event) => event.screenshot);
    assert(screenshots.length > 0);
    for (const event of screenshots) assert.equal((await readFile(event.screenshot!)).subarray(1, 4).toString(), 'PNG');
    assert(!JSON.stringify(result).includes('screenshot-secret'));
  } finally { await f.cleanup(); }
});

test('page-discovered bridge rejects forged events without the private nonce', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    await f.recorder.page.evaluate(async () => {
      const host = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const binding = Object.keys(window).find((key) => key.startsWith('__journeyproof_event_'))!;
      if (!binding) throw new Error('Expected a discoverable bridge for the attack');
      const fake = { action: 'fill', url: location.href, label: 'Forged password', locators: [{ strategy: 'testId', value: 'password' }], value: 'forged-plaintext-secret', redacted: false };
      await host[binding](fake);
      await host[binding]('guessed-nonce', fake);
    });
    await f.recorder.page.getByTestId('title').fill('Real edit');
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.map((event) => event.action), ['navigate', 'fill']);
    assert.equal(result.events[1].value, 'Real edit');
    assert(!JSON.stringify(result).includes('forged-plaintext-secret'));
    assert(result.warnings.some((warning) => /unauthenticated/.test(warning)));
  } finally { await f.cleanup(); }
});

test('replacing the global binding cannot intercept real events or the nonce', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      const binding = Object.keys(window).find((key) => key.startsWith('__journeyproof_event_'))!;
      const stolen: unknown[] = [];
      host.stolen = stolen;
      host[binding] = (...args: unknown[]) => { stolen.push(args); return Promise.resolve(); };
    });
    await page.locator('#password').fill('real-password-secret');
    await page.getByTestId('save').click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { stolen: unknown[] }).stolen), []);
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.map((event) => event.action), ['navigate', 'fill', 'click']);
    assert.equal(result.events[1].value, '[REDACTED]');
  } finally { await f.cleanup(); }
});

test('hostile stop replacement is blocked and a poisoned flush cannot hang cancellation', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    const defence = await page.evaluate(async () => {
      const host = window as unknown as Record<string, unknown>;
      const control = Object.getOwnPropertyNames(window).find((key) => key.startsWith('__journeyproof_stop_'))!;
      const descriptor = Object.getOwnPropertyDescriptor(window, control)!;
      const replaced = Reflect.set(window, control, () => new Promise(() => {}));
      const unauthorized = await (host[control] as (token?: string) => Promise<boolean>)();
      return { replaced, unauthorized, writable: descriptor.writable, configurable: descriptor.configurable };
    });
    assert.deepEqual(defence, { replaced: false, unauthorized: false, writable: false, configurable: false });
    await page.getByTestId('title').fill('Last edit');
    // Even a non-replaceable stop callback runs in a hostile realm: poison its
    // Promise.all to exercise the native deadline using a genuinely stalled page.
    await page.evaluate(() => { Promise.all = (() => new Promise(() => {})) as typeof Promise.all; });
    const started = Date.now();
    const result = await f.recorder.stop();
    assert(Date.now() - started < 5_000, 'Cancellation hung on hostile page code');
    assert(page.isClosed());
    assert(result.warnings.some((warning) => /1500ms.*incomplete/.test(warning)));
  } finally { await f.cleanup(); }
});

test('native packet validation rejects oversized values and malformed locators', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    await f.recorder.page.getByTestId('title').fill('x'.repeat(8193));
    await f.recorder.page.getByTestId('save').click();
    // Native test access supplies the nonce solely to exercise schema rejection;
    // no page-facing API exposes this privileged recorder object.
    const nonce = (f.recorder as unknown as { nonce: string }).nonce;
    await f.recorder.page.evaluate(async (token) => {
      const host = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const binding = Object.keys(window).find((key) => key.startsWith('__journeyproof_event_'))!;
      const packet = { action: 'click', url: location.origin, label: 'bad', locators: [{ strategy: 'execute', value: 'bad' }] };
      await host[binding](token, packet);
      await host[binding](token, { ...packet, action: 'execute', locators: [] });
      await host[binding](token, { ...packet, locators: Array(9).fill({ strategy: 'css', value: 'body' }) });
    }, nonce);
    const result = await f.recorder.stop();
    assert.deepEqual(result.events.map((event) => event.action), ['navigate', 'click']);
    assert(result.warnings.some((warning) => /invalid or oversized/.test(warning)));
  } finally { await f.cleanup(); }
});

test('native event reservations and network ledger stop at their documented caps', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = f.recorder.page;
    await page.evaluate(() => { for (let index = 0; index < 510; index++) history.pushState({}, '', `/step-${index}`); });
    await page.evaluate(async () => {
      for (let batch = 0; batch < 21; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => fetch(`/api?batch=${batch}&index=${index}`)));
    });
    const result = await f.recorder.stop();
    assert.equal(result.events.length, 500);
    assert.equal(f.observed.length, 500);
    assert.equal(result.network.length, 2000);
    assert.equal(result.events.at(-1)?.sequence, 500);
    assert(result.warnings.some((warning) => /500.*truncated/.test(warning)));
    assert(result.warnings.some((warning) => /2000.*truncated/.test(warning)));
  } finally { await f.cleanup(); }
});
