import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Route, type LaunchOptions, type BrowserContextOptions } from 'playwright';
import { BrowserRecorder } from '../src/core/recorder';
import { JourneyService } from '../src/core/service';

// A real Chromium context with synthetic HTTPS responses: CI never signs in to
// a company service, sends forms to it, or depends on its network availability.
async function remoteFixture(
  t: TestContext,
  handler: (route: Route) => Promise<void>,
  readinessTimeoutMs?: number,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-remote-'));
  const launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async (options?: LaunchOptions) => {
    const browser = await launch(options);
    const createContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (contextOptions?: BrowserContextOptions) => {
      const context = await createContext(contextOptions);
      await context.route('https://*.example.test/**', handler);
      return context;
    });
    return browser;
  });
  const recorder = new BrowserRecorder({
    artifactDir: root,
    onEvent: () => {},
    readinessTimeoutMs,
  });
  t.after(async () => {
    await recorder.stop();
    await rm(root, { recursive: true, force: true });
  });
  return recorder;
}

test(
  'cross-origin HTTP login redirects remain recordable without leaking callback parameters',
  { timeout: 15000 },
  async (t) => {
    // Real HTTP redirects are used here because Chromium's routing interception
    // does not re-intercept every redirect hop. HTTPS input is exercised below
    // and the opt-in live check covers the actual external HTTPS redirect.
    const servers = [
      createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          '<label>Email<input type="email" name="email"></label><button onclick="this.textContent=\'Ready\'">Continue</button>',
        );
      }),
    ];
    await new Promise<void>((resolve) => servers[0].listen(0, '127.0.0.1', resolve));
    const address = servers[0].address();
    assert.ok(address && typeof address !== 'string');
    const loginOrigin = `http://127.0.0.1:${address.port}`;
    servers.push(
      createServer((_request, response) => {
        response.writeHead(307, { Location: `${loginOrigin}/login?token=redirect-secret` });
        response.end();
      }),
    );
    await new Promise<void>((resolve) => servers[1].listen(0, '127.0.0.1', resolve));
    const appAddress = servers[1].address();
    assert.ok(appAddress && typeof appAddress !== 'string');
    const root = await mkdtemp(path.join(tmpdir(), 'testloom-redirect-'));
    const recorder = new BrowserRecorder({ artifactDir: root, onEvent: () => {} });
    t.after(async () => {
      await recorder.stop();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      await rm(root, { recursive: true, force: true });
    });
    await recorder.start(`http://127.0.0.1:${appAddress.port}/connectors/custom`, {
      headless: true,
    });
    const page = recorder.page;
    assert.equal(new URL(page.url()).origin, loginOrigin);
    await page.getByLabel('Email').fill('private@example.test');
    await page.getByRole('button', { name: 'Continue' }).click();
    const result = await recorder.stop();
    assert.ok(result.events.some((e) => e.action === 'click'));
    assert.ok(
      result.events.some((e) => e.action === 'fill' && e.redacted && e.value === '[REDACTED]'),
    );
    assert.ok(result.warnings.some((w) => /redirected.*sign-in/.test(w)));
    assert.ok(result.network.some((r) => r.status === 307));
    assert.ok(!JSON.stringify(result).includes('redirect-secret'));
    assert.ok(!JSON.stringify(result).includes('private@example.test'));
    assert.ok(page.isClosed());
  },
);

test(
  'a committed remote page stays open when an optional script delays DOM readiness',
  { timeout: 15000 },
  async (t) => {
    let slow: Route | undefined;
    const recorder = await remoteFixture(
      t,
      async (route) => {
        if (new URL(route.request().url()).pathname === '/slow.js') {
          slow = route;
          return;
        }
        await route.fulfill({
          contentType: 'text/html',
          body: '<script src="/slow.js"></script><button onclick="this.textContent=\'Ready\'">Continue</button>',
        });
      },
      100,
    );
    await recorder.start('https://app.example.test/slow', { headless: true });
    const page = recorder.page;
    assert.ok(!page.isClosed());
    assert.ok(slow, 'The browser reached the response and requested its blocking script.');
    await slow.fulfill({
      contentType: 'application/javascript',
      body: 'window.fixtureReady=true;',
    });
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Continue' }).click();
    const result = await recorder.stop();
    assert.ok(result.warnings.some((w) => /still loading.*remains open/.test(w)));
    assert.ok(result.events.some((e) => e.action === 'click'));
  },
);

test(
  'a real navigation DNS failure reports network guidance, not a missing browser or a private URL',
  { timeout: 15000 },
  async (t) => {
    const recorder = await remoteFixture(t, async (route) => {
      await route.abort('namenotresolved');
    });
    await assert.rejects(
      recorder.start('https://app.example.test/private?token=do-not-log', { headless: true }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /hostname could not be resolved/);
        assert.match(error.message, /VPN/);
        assert.doesNotMatch(error.message, /install|do-not-log|\/private/);
        return true;
      },
    );
    assert.throws(() => recorder.page, /not open/);
  },
);

test(
  'an HTTP access error is visible and can be recorded as an expected negative response',
  { timeout: 15000 },
  async (t) => {
    const recorder = await remoteFixture(t, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'text/html',
        body: '<h1>Access denied</h1>',
      });
    });
    await recorder.start('https://app.example.test/restricted', { headless: true });
    assert.equal(await recorder.page.getByRole('heading').textContent(), 'Access denied');
    const result = await recorder.stop();
    assert.ok(result.warnings.some((w) => /HTTP 403/.test(w)));
    assert.ok(result.network.some((r) => r.status === 403));
  },
);

test('recording a remote URL does not start an unrelated local demo server', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-remote-service-'));
  const project = path.join(root, 'source');
  await mkdir(project);
  await writeFile(
    path.join(project, 'package.json'),
    '{"devDependencies":{"@playwright/test":"1.63.0"}}',
  );
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.connect(project);
  service.state.project!.isDemo = true;
  service.state.project!.demoPort = 4318;
  let demoStarts = 0;
  t.mock.method(service as unknown as { startDemo(): Promise<void> }, 'startDemo', async () => {
    demoStarts++;
  });
  t.mock.method(BrowserRecorder.prototype, 'start', async () => {});
  t.mock.method(BrowserRecorder.prototype, 'stop', async () => ({
    events: [],
    network: [],
    warnings: [],
  }));
  await service.startRecording({
    url: 'https://app.example.test/connectors/custom',
    name: 'Remote app',
    captureScreenshots: false,
  });
  assert.equal(demoStarts, 0);
  assert.equal(service.state.phase, 'recording');
  await service.stopRecording();
  await service.startRecording({
    url: 'http://127.0.0.1:4318/',
    name: 'Local demo',
    captureScreenshots: false,
  });
  assert.equal(demoStarts, 1);
  await service.stopRecording();
  await service.startRecording({
    url: 'http://localhost:4318/',
    name: 'Local alias',
    captureScreenshots: false,
  });
  assert.equal(demoStarts, 2);
  await service.stopRecording();
});
