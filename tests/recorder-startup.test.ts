import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { chromium, errors, type Browser, type LaunchOptions } from 'playwright';
import playwrightPackage from 'playwright/package.json';
import {
  launchRecordingBrowser,
  missingBrowser,
  recordingStartupMessage,
} from '../src/core/recorder-startup.js';

const privateDetails =
  '\nCall log: navigating to https://private.example/PRIVATE_ROUTE?token=URL_TOKEN#PRIVATE_FRAGMENT' +
  '\nExecutable: /Users/private-person/PRIVATE_FOLDER/Chromium' +
  '\nPage text: PRIVATE_PAGE_TEXT';
const missingExecutable = new Error(
  "browserType.launch: Executable doesn't exist at /Users/private-person/PRIVATE_FOLDER/chromium",
);
const installedBrowserCrash = new Error(
  'browserType.launch: Target page, context or browser has been closed\n' +
    'Browser logs:\n<launching> /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n' +
    '<launched> pid=4321\n[pid=4321][err] dyld: Library not loaded: @rpath/PrivateFramework\n' +
    '[pid=4321][err] Reason: image not found',
);
const messages = {
  missing: `No recording browser was found. Install Google Chrome or Microsoft Edge, or run npx playwright@${playwrightPackage.version} install chromium once, then retry. This does not mean the website URL is invalid.`,
  dns: 'The website’s hostname could not be resolved. Check the address and connect to the required company VPN or DNS network, then retry.',
  tls: 'The website’s HTTPS certificate could not be verified. Check the certificate and any required company VPN or trusted certificate setup. Testloom keeps HTTPS verification enabled.',
  proxy:
    'The recording browser could not connect through the network proxy. Check your company proxy or VPN configuration, then retry.',
  navigationTimeout:
    'The website did not respond in time. Check its availability and any required VPN, then retry. The recording browser is installed.',
  browserTimeout:
    'The recording browser did not become ready in time. Close its leftover windows, check device policy, then retry.',
  closed:
    'The recording browser closed before startup finished. Keep its window open while recording; check device policy if it closes by itself.',
  browser:
    'The recording browser could not launch. Check that Chrome or Edge can open on this Mac and that device policy permits automation.',
  setup:
    'The browser opened, but recording setup failed. Check local disk space and permissions, then retry.',
  navigation:
    'The browser opened, but navigation failed. Check this address in a browser on the same Mac, including any required sign-in, VPN or company access policy.',
};

function assertPrivateDetailsAbsent(message: string): void {
  assert.doesNotMatch(
    message,
    /private\.example|PRIVATE_ROUTE|URL_TOKEN|PRIVATE_FRAGMENT|private-person|PRIVATE_FOLDER|PRIVATE_PAGE_TEXT|PrivateFramework|\/Applications\/|\/Users\//,
  );
}

test('missingBrowser recognizes genuine missing executables and distributions', () => {
  for (const error of [
    missingExecutable,
    new Error('browserType.launch: Executable not found at /missing/chromium'),
    new Error("browserType.launch: Chromium distribution 'chrome' is not found at /missing/chrome"),
    new Error('Please run the following command: npx playwright install chromium'),
    new Error('TESTLOOM_BROWSER_MISSING'),
  ]) {
    assert.equal(missingBrowser(error), true, String(error));
  }
});

test('missingBrowser does not mistake an installed browser crash for executable absence', () => {
  for (const error of [
    installedBrowserCrash,
    new Error('browserType.launch: Target page, context or browser has been closed'),
    new Error('browserType.launch: spawn /Applications/Google Chrome.app EACCES'),
    new Error('browserType.launch: process exited with signal SIGABRT'),
    new errors.TimeoutError('browserType.launch: Timeout 30000ms exceeded'),
  ]) {
    assert.equal(missingBrowser(error), false, String(error));
  }
});

type Stage = Parameters<typeof recordingStartupMessage>[1];
const classifications: { name: string; stage: Stage; errors: string[]; expected: string }[] = [
  {
    name: 'missing browser',
    stage: 'browser',
    errors: [String(missingExecutable), 'TESTLOOM_BROWSER_MISSING'],
    expected: messages.missing,
  },
  {
    name: 'DNS failure',
    stage: 'navigation',
    errors: ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_RESOLUTION_FAILED'],
    expected: messages.dns,
  },
  {
    name: 'TLS failure',
    stage: 'navigation',
    errors: [
      'net::ERR_CERT_AUTHORITY_INVALID',
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_SSL_PROTOCOL_ERROR',
    ],
    expected: messages.tls,
  },
  {
    name: 'proxy failure',
    stage: 'navigation',
    errors: [
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_TUNNEL_CONNECTION_FAILED',
      'net::ERR_NO_SUPPORTED_PROXIES',
    ],
    expected: messages.proxy,
  },
  {
    name: 'navigation timeout',
    stage: 'navigation',
    errors: [
      'TimeoutError: Timeout 30000ms exceeded',
      'net::ERR_TIMED_OUT',
      'net::ERR_CONNECTION_TIMED_OUT',
    ],
    expected: messages.navigationTimeout,
  },
  {
    name: 'browser timeout',
    stage: 'browser',
    errors: ['TimeoutError: Timeout 30000ms exceeded'],
    expected: messages.browserTimeout,
  },
  {
    name: 'setup timeout',
    stage: 'setup',
    errors: ['TimeoutError: Timeout 30000ms exceeded'],
    expected: messages.browserTimeout,
  },
  {
    name: 'installed browser crash',
    stage: 'browser',
    errors: [String(installedBrowserCrash)],
    expected: messages.closed,
  },
  ...(['browser', 'setup', 'navigation'] as const).map((stage) => ({
    name: `unknown ${stage} failure`,
    stage,
    errors: ['Unrecognized internal error'],
    expected: messages[stage],
  })),
];

for (const entry of classifications) {
  test(`startup reports a fixed safe message for ${entry.name}`, () => {
    for (const detail of entry.errors) {
      // Exercise both string rejections and Error objects with private browser diagnostics.
      for (const error of [detail + privateDetails, new Error(detail + privateDetails)]) {
        const message = recordingStartupMessage(error, entry.stage);
        assertPrivateDetailsAbsent(message);
        assert.equal(message, entry.expected);
      }
    }
  });
}

test('a navigation error mentioning a missing browser is not installation advice', () => {
  const message = recordingStartupMessage(
    new Error('TESTLOOM_BROWSER_MISSING' + privateDetails),
    'navigation',
  );
  assert.equal(message, messages.navigation);
  assertPrivateDetailsAbsent(message);
});

const unsupportedBrowserOperation = async (): Promise<never> => {
  throw new Error(
    'This startup-only browser stub must not create pages or run browser operations.',
  );
};

// Implement Browser instead of asserting that an empty object is one. Unexpected browser work fails.
class StubBrowser extends EventEmitter implements Browser {
  private connected = true;
  bind: Browser['bind'] = unsupportedBrowserOperation;
  newBrowserCDPSession: Browser['newBrowserCDPSession'] = unsupportedBrowserOperation;
  newContext: Browser['newContext'] = unsupportedBrowserOperation;
  newPage: Browser['newPage'] = unsupportedBrowserOperation;
  startTracing: Browser['startTracing'] = unsupportedBrowserOperation;
  stopTracing: Browser['stopTracing'] = unsupportedBrowserOperation;
  unbind: Browser['unbind'] = unsupportedBrowserOperation;

  browserType() {
    return chromium;
  }
  contexts() {
    return [];
  }
  isConnected() {
    return this.connected;
  }
  version() {
    return 'startup-test-stub';
  }
  async close() {
    this.connected = false;
    this.emit('disconnected', this);
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
  removeAllListeners(event?: string | symbol): this;
  removeAllListeners(
    event: string | undefined,
    options: { behavior?: 'wait' | 'ignoreErrors' | 'default' },
  ): Promise<void>;
  removeAllListeners(
    event?: string | symbol,
    options?: { behavior?: 'wait' | 'ignoreErrors' | 'default' },
  ): this | Promise<void> {
    super.removeAllListeners(event);
    return options ? Promise.resolve() : this;
  }
}

function launchOptions(): LaunchOptions {
  return {
    headless: false,
    args: ['--remote-debugging-port=0', '--disable-dev-shm-usage'],
    timeout: 4321,
    slowMo: 12,
    chromiumSandbox: true,
    env: { TESTLOOM_STARTUP_TEST: 'option-preserved' },
    proxy: {
      server: 'http://proxy.example:8080',
      username: 'synthetic-user',
      password: 'synthetic-password',
    },
  };
}

test('launch returns bundled Chromium without a fallback notice and preserves options', async (t) => {
  const browser: Browser = new StubBrowser();
  const options = launchOptions();
  const before = structuredClone(options);
  const warnings: string[] = [];
  const launch = t.mock.method(chromium, 'launch', async (): Promise<Browser> => browser);
  const result = await launchRecordingBrowser(
    options,
    (message) => warnings.push(message),
    () => {},
  );
  assert.equal(result, browser);
  assert.equal(result.isConnected(), true);
  assert.equal(result.browserType(), chromium);
  assert.equal(launch.mock.callCount(), 1);
  assert.deepEqual(launch.mock.calls[0].arguments, [before]);
  assert.deepEqual(options, before);
  assert.deepEqual(warnings, []);
  await result.close();
  assert.equal(result.isConnected(), false);
});

for (const [channel, label] of [
  ['chrome', 'Google Chrome'],
  ['msedge', 'Microsoft Edge'],
] as const) {
  test(`launch falls back to installed ${label} and preserves caller options`, async (t) => {
    const browser: Browser = new StubBrowser();
    const options = launchOptions();
    const before = structuredClone(options);
    const warnings: string[] = [];
    const attempts: LaunchOptions[] = [];
    t.mock.method(chromium, 'launch', async (candidate?: LaunchOptions): Promise<Browser> => {
      assert.ok(candidate);
      attempts.push(structuredClone(candidate));
      if (candidate.channel === channel) return browser;
      throw missingExecutable;
    });
    const result = await launchRecordingBrowser(
      options,
      (message) => warnings.push(message),
      () => {},
    );
    assert.equal(result, browser);
    assert.equal(result.isConnected(), true);
    assert.deepEqual(options, before);
    assert.deepEqual(
      attempts
        .filter((candidate) => !candidate.executablePath)
        .map((candidate) => candidate.channel),
      channel === 'chrome' ? [undefined, 'chrome'] : [undefined, 'chrome', 'msedge'],
    );
    for (const candidate of attempts) {
      const { channel: selectedChannel, executablePath, ...forwarded } = candidate;
      assert.deepEqual(forwarded, before);
      if (executablePath) {
        // macOS may insert a per-user Chrome candidate before the Edge channel.
        assert.equal(channel, 'msedge');
        assert.equal(selectedChannel, undefined);
        assert.match(
          executablePath,
          /Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/,
        );
      }
    }
    assert.deepEqual(warnings, [
      `Using installed ${label} in a fresh recording browser. Your existing browser login is not shared.`,
    ]);
    assertPrivateDetailsAbsent(warnings[0]);
    assert.doesNotMatch(warnings[0], /proxy\.example|synthetic-user|synthetic-password/);
    await result.close();
  });
}

test('launch exhausts missing candidates with a safe missing-browser sentinel', async (t) => {
  const warnings: string[] = [];
  const attempts: LaunchOptions[] = [];
  t.mock.method(chromium, 'launch', async (options?: LaunchOptions): Promise<Browser> => {
    assert.ok(options);
    attempts.push(options);
    throw missingExecutable;
  });
  await assert.rejects(
    launchRecordingBrowser(
      {},
      (message) => warnings.push(message),
      () => {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'TESTLOOM_BROWSER_MISSING');
      assertPrivateDetailsAbsent(error.message);
      return true;
    },
  );
  assert.deepEqual(
    attempts.filter((candidate) => !candidate.executablePath).map((candidate) => candidate.channel),
    [undefined, 'chrome', 'msedge'],
  );
  assert.deepEqual(warnings, []);
});

for (const [name, failure] of [
  ['permission failure', new Error('browserType.launch: spawn EACCES' + privateDetails)],
  ['installed browser crash', installedBrowserCrash],
] as const) {
  test(`launch does not fall back after ${name}`, async (t) => {
    const warnings: string[] = [];
    const launch = t.mock.method(chromium, 'launch', async (): Promise<Browser> => {
      throw failure;
    });
    await assert.rejects(
      launchRecordingBrowser(
        {},
        (message) => warnings.push(message),
        () => {},
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(launch.mock.callCount(), 1);
    assert.deepEqual(warnings, []);
  });
}

test('a Chrome runtime failure stops fallback before Edge is attempted', async (t) => {
  const failure = new Error('browserType.launch: process exited with signal SIGABRT');
  const warnings: string[] = [];
  const launch = t.mock.method(
    chromium,
    'launch',
    async (options?: LaunchOptions): Promise<Browser> => {
      if (!options?.channel) throw missingExecutable;
      throw failure;
    },
  );
  await assert.rejects(
    launchRecordingBrowser(
      {},
      (message) => warnings.push(message),
      () => {},
    ),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(
    launch.mock.calls.map((call) => call.arguments[0]?.channel),
    [undefined, 'chrome'],
  );
  assert.deepEqual(warnings, []);
});

test('cancellation before startup prevents the first launch', async (t) => {
  const cancelled = new Error('Recording cancelled.');
  const warnings: string[] = [];
  const launch = t.mock.method(chromium, 'launch', async (): Promise<Browser> => new StubBrowser());
  await assert.rejects(
    launchRecordingBrowser(
      {},
      (message) => warnings.push(message),
      () => {
        throw cancelled;
      },
    ),
    (error: unknown) => error === cancelled,
  );
  assert.equal(launch.mock.callCount(), 0);
  assert.deepEqual(warnings, []);
});

test('cancellation during a failed launch prevents the next browser attempt', async (t) => {
  const cancelled = new Error('Recording cancelled.');
  let cancellationRequested = false;
  const warnings: string[] = [];
  const launch = t.mock.method(chromium, 'launch', async (): Promise<Browser> => {
    cancellationRequested = true;
    throw missingExecutable;
  });
  await assert.rejects(
    launchRecordingBrowser(
      {},
      (message) => warnings.push(message),
      () => {
        if (cancellationRequested) throw cancelled;
      },
    ),
    (error: unknown) => error === cancelled,
  );
  assert.equal(launch.mock.callCount(), 1);
  assert.deepEqual(warnings, []);
});
