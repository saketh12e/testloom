import assert from 'node:assert/strict';
import { arch, platform, release } from 'node:os';
import { test } from 'node:test';
import appPackage from '../package.json';
import playwrightPackage from 'playwright/package.json';
import {
  addBrowserAttempt,
  BROWSER_DIAGNOSTIC_LABELS,
  classifyBrowserFailure,
  createBrowserStartupReport,
  finalizeBrowserStartupReport,
  MAX_BROWSER_STARTUP_ATTEMPTS,
  parseBrowserStartupReport,
  type BrowserFailureCategory,
} from '../src/core/browser-diagnostics.js';

const PRIVATE_DETAILS =
  '\nCall log: navigating to https://PRIVATE_HOST.invalid/PRIVATE_ROUTE?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT' +
  '\nExecutable: /Users/PRIVATE_USER/PRIVATE_FOLDER/Google Chrome' +
  '\nPage text: PRIVATE_PAGE_TEXT\nAuthorization: Bearer PRIVATE_AUTH';

function assertSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /PRIVATE_|https?:|\/Users\/|Authorization|Bearer/);
}

function checkCategory(message: string, expected: BrowserFailureCategory) {
  const error = new Error(message + PRIVATE_DETAILS);
  const failure = classifyBrowserFailure(error);
  assert.equal(failure.category, expected, message);
  assertSafe(failure);
  const report = createBrowserStartupReport();
  addBrowserAttempt(report, 'Playwright Chromium', error);
  finalizeBrowserStartupReport(report, 'failed');
  assert.equal(report.attempts[0].category, expected);
  assertSafe(report);
}

test('report metadata comes from the app, Playwright and OS with a fresh UUID and ISO timestamp', () => {
  const before = Date.now();
  const report = createBrowserStartupReport();
  const after = Date.now();
  assert.equal(report.schemaVersion, 1);
  assert.match(report.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(new Date(report.createdAt).toISOString(), report.createdAt);
  assert.ok(Date.parse(report.createdAt) >= before && Date.parse(report.createdAt) <= after);
  assert.equal(report.appVersion, appPackage.version);
  assert.equal(report.playwrightVersion, playwrightPackage.version);
  assert.equal(report.platform, platform());
  assert.equal(report.arch, arch());
  assert.equal(report.osVersion, release());
  assert.equal(report.stage, 'browser');
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.attempts, []);
  assert.notEqual(createBrowserStartupReport().id, report.id);
  assert.deepEqual(Object.keys(report).sort(), [
    'appVersion',
    'arch',
    'attempts',
    'createdAt',
    'id',
    'osVersion',
    'outcome',
    'platform',
    'playwrightVersion',
    'schemaVersion',
    'stage',
  ]);
  assertSafe(report);
});

test('recognizes missing executables from the headline only', () => {
  for (const headline of [
    "browserType.launch: Executable doesn't exist at /Users/PRIVATE_USER/browser",
    'browserType.launch: Executable not found at /Users/PRIVATE_USER/browser',
    "browserType.launch: Chromium distribution 'chrome' is not found at /Users/PRIVATE_USER/browser",
    'Browser not found',
    'Please run the following command: npx playwright install chromium',
    'TESTLOOM_BROWSER_MISSING',
  ])
    checkCategory(headline, 'missing');
});

test('dyld image-not-found crash is closed, never a missing browser or policy restriction', () => {
  for (const newline of ['\n', '\r\n']) {
    const message = [
      'browserType.launch: Target page, context or browser has been closed',
      '<launching> /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '<launched> pid=4321',
      '[pid=4321][err] dyld: Library not loaded: @rpath/PRIVATE_LIBRARY',
      '[pid=4321][err] Reason: image not found',
      '<process did exit: exitCode=null, signal=SIGABRT>',
    ].join(newline);
    checkCategory(message, 'closed');
    assert.deepEqual(classifyBrowserFailure(message), { category: 'closed', signal: 'SIGABRT' });
  }
  checkCategory('browserType.launch: Target closed\nExecutable not found', 'closed');
  checkCategory('browserType.launch: Target closed; Reason: image not found', 'closed');
  checkCategory('Something failed\nPlease run playwright install chromium', 'unknown');
});

test('recognizes actual architecture and OS incompatibility ahead of generic closure', () => {
  for (const reason of [
    'TESTLOOM_BUNDLE_INVALID',
    'TESTLOOM_MACOS_UNSUPPORTED',
    "dlopen(/Users/PRIVATE_USER/browser): mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')",
    'mach-o, but wrong architecture',
    'spawn /Users/PRIVATE_USER/browser: Bad CPU type in executable',
    'Exec format error',
    'ERROR_BAD_EXE_FORMAT',
    '%1 is not a valid Win32 application',
    'Unsupported operating system',
    'Unsupported architecture',
    'This browser requires macOS 14.0 or later',
    'built for macOS 14.0 which is newer than running OS',
  ])
    checkCategory(
      `browserType.launch: Target page, context or browser has been closed\n${reason}`,
      'incompatible',
    );
});

test('policy requires explicit restriction markers, including managed remote debugging', () => {
  for (const reason of [
    'net::ERR_BLOCKED_BY_ADMINISTRATOR',
    'net::ERR_BLOCKED_BY_POLICY',
    'DevTools disabled',
    'DevTools is disabled',
    'Developer tools have been disabled',
    'Remote debugging is disabled by policy',
    'Remote debugging has been disabled by enterprise policy',
    'Remote debugging is not allowed by administrator policy',
    'RemoteDebuggingAllowed=false',
    'DeveloperToolsAvailability: 2',
  ])
    checkCategory(`browserType.launch: Target closed\n${reason}`, 'policy');
  for (const reason of [
    'browserType.launch: Target page, context or browser has been closed',
    'browser disconnected',
    'process exited with signal SIGKILL',
    'Target closed\nCheck device policy',
    'Target closed\nRemoteDebuggingAllowed=true',
    'Target closed\nDeveloperToolsAvailability: 0',
    'Target closed\nRemote debugging requires a non-default data directory',
  ])
    checkCategory(reason, 'closed');
  checkCategory('net::ERR_BLOCKED_BY_CLIENT', 'unknown');
  checkCategory('net::ERR_ACCESS_DENIED', 'unknown');
});

test('permission and timeout evidence takes priority over a generic closed target', () => {
  for (const reason of ['EACCES', 'EPERM', 'Permission denied', 'Operation not permitted'])
    checkCategory(`browserType.launch: Target closed\n${reason}`, 'permission');
  for (const reason of [
    'TimeoutError: Timeout 30000ms exceeded',
    'connection timed out',
    'net::ERR_TIMED_OUT',
    'net::ERR_CONNECTION_TIMED_OUT',
  ])
    checkCategory(`browserType.launch: Target closed\n${reason}`, 'timeout');
  checkCategory('An unrecognized browser failure', 'unknown');
});

test('extracts numeric exit codes and allowlisted signals from Playwright process-exit records', () => {
  for (const code of [0, 1, -1, 127, 137, 2147483647, -2147483648]) {
    const failure = classifyBrowserFailure(
      `Target closed\n[pid=15] <process did exit: exitCode=${code}, signal=null>${PRIVATE_DETAILS}`,
    );
    assert.deepEqual(failure, { category: 'closed', exitCode: code });
    assertSafe(failure);
  }
  for (const signal of ['SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGTERM', 'SIGILL', 'SIGBUS']) {
    const failure = classifyBrowserFailure(
      `Target closed\n[pid=15] <process did exit: exitCode=null, signal=${signal}>${PRIVATE_DETAILS}`,
    );
    assert.deepEqual(failure, { category: 'closed', signal });
    assertSafe(failure);
    const report = createBrowserStartupReport();
    addBrowserAttempt(
      report,
      'Google Chrome',
      new Error(`<process did exit: exitCode=12, signal=${signal}>${PRIVATE_DETAILS}`),
    );
    assert.deepEqual(report.attempts[0], {
      browser: 'Google Chrome',
      outcome: 'failed',
      category: 'closed',
      exitCode: 12,
      signal,
    });
    assertSafe(report);
  }
});

test('does not copy malformed codes, arbitrary signal strings, or process metadata', () => {
  for (const [code, signal] of [
    ['PRIVATE_CODE', 'PRIVATE_SIGNAL'],
    ['2147483648', 'SIGPRIVATE_SECRET'],
    ['-2147483649', 'https://PRIVATE_HOST.invalid'],
    ['Infinity', '/Users/PRIVATE_USER/PRIVATE_FOLDER'],
    ['1e3', 'SIGKILL PRIVATE_TOKEN'],
    ['1.5', 'sigkill'],
    ['null', '9'],
    ['NaN', 'null'],
  ]) {
    const error = `<process did exit: exitCode=${code}, signal=${signal}>${PRIVATE_DETAILS}`;
    assert.deepEqual(classifyBrowserFailure(error), { category: 'closed' });
    const report = addBrowserAttempt(createBrowserStartupReport(), 'Google Chrome', error);
    assert.deepEqual(report.attempts[0], {
      browser: 'Google Chrome',
      outcome: 'failed',
      category: 'closed',
    });
    assertSafe(report);
  }
  assert.deepEqual(classifyBrowserFailure('exitCode=12 signal=SIGKILL'), { category: 'unknown' });
});

test('keeps code and signal from the same final exit marker', () => {
  assert.deepEqual(
    classifyBrowserFailure(
      '<process did exit: exitCode=1, signal=SIGABRT>\n<process did exit: exitCode=null, signal=SIGKILL>',
    ),
    { category: 'closed', signal: 'SIGKILL' },
  );
  assert.deepEqual(
    classifyBrowserFailure(
      '<process did exit: exitCode=null, signal=SIGABRT>\n<process did exit: exitCode=0, signal=null>',
    ),
    { category: 'closed', exitCode: 0 },
  );
  assert.deepEqual(
    classifyBrowserFailure(
      '<process did exit: exitCode=1, signal=SIGABRT>\n<process did exit: exitCode=PRIVATE_CODE, signal=PRIVATE_SIGNAL>',
    ),
    { category: 'closed' },
  );
});

test('oversized errors retain the headline and final exit without serializing the log', () => {
  const error =
    'Target closed\n' +
    PRIVATE_DETAILS.repeat(2000) +
    '\n<process did exit: exitCode=null, signal=SIGABRT>';
  const report = addBrowserAttempt(createBrowserStartupReport(), 'Playwright Chromium', error);
  assert.equal(report.attempts[0].category, 'closed');
  assert.equal(report.attempts[0].signal, 'SIGABRT');
  assert.ok(JSON.stringify(report).length < 1000);
  assertSafe(report);
});

test('unknown error values and throwing string conversions do not break diagnostics', () => {
  for (const error of [
    null,
    undefined,
    12,
    false,
    {},
    Symbol('PRIVATE_TOKEN'),
    {
      toString() {
        throw new Error('PRIVATE_TOKEN');
      },
    },
  ]) {
    assert.deepEqual(classifyBrowserFailure(error), { category: 'unknown' });
    assertSafe(classifyBrowserFailure(error));
  }
});

test('attempt labels are allowlisted at runtime and ready attempts never retain error fields', () => {
  for (const label of BROWSER_DIAGNOSTIC_LABELS) {
    const report = createBrowserStartupReport();
    assert.equal(addBrowserAttempt(report, label), report);
    assert.deepEqual(report.attempts, [{ browser: label, outcome: 'ready', category: 'unknown' }]);
    assertSafe(report);
  }
  for (const label of [
    'Google Chrome\nPRIVATE_TOKEN',
    '/Users/PRIVATE_USER/browser',
    PRIVATE_DETAILS,
  ]) {
    const report = createBrowserStartupReport();
    assert.throws(() => addBrowserAttempt(report, label, new Error(PRIVATE_DETAILS)), {
      message: 'Invalid browser diagnostic label.',
    });
    assert.equal(report.attempts.length, 0);
    assertSafe(report);
  }
});

test('attempt history is bounded at ten and preserves order', () => {
  const report = createBrowserStartupReport();
  for (let index = 0; index < 100; index++)
    addBrowserAttempt(
      report,
      'Testloom Chromium',
      `<process did exit: exitCode=${index}, signal=null>${PRIVATE_DETAILS}`,
    );
  assert.equal(report.attempts.length, 10);
  assert.equal(report.attempts.length, MAX_BROWSER_STARTUP_ATTEMPTS);
  assert.deepEqual(
    report.attempts.map(({ exitCode }) => exitCode),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assertSafe(report);
});

test('finalizing ready, failed and cancelled reports preserves metadata and attempt history', () => {
  for (const outcome of ['ready', 'failed', 'cancelled'] as const) {
    const report = createBrowserStartupReport('setup');
    const metadata = { ...report };
    addBrowserAttempt(report, 'Playwright Chromium', new Error('Target closed' + PRIVATE_DETAILS));
    addBrowserAttempt(report, 'Google Chrome');
    const attempts = JSON.stringify(report.attempts);
    assert.equal(finalizeBrowserStartupReport(report, outcome, 'navigation'), report);
    assert.equal(report.outcome, outcome);
    assert.equal(report.stage, 'navigation');
    assert.equal(JSON.stringify(report.attempts), attempts);
    const { attempts: _attempts, stage: _stage, outcome: _outcome, ...actualMetadata } = report;
    const {
      attempts: _oldAttempts,
      stage: _oldStage,
      outcome: _oldOutcome,
      ...expectedMetadata
    } = metadata;
    assert.deepEqual(actualMetadata, expectedMetadata);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assertSafe(report);
  }
  const report = createBrowserStartupReport('setup');
  finalizeBrowserStartupReport(report, 'cancelled');
  assert.equal(report.stage, 'setup');
});

test('setup and navigation failures remain visible after a ready browser attempt', () => {
  for (const stage of ['setup', 'navigation'] as const) {
    const report = addBrowserAttempt(createBrowserStartupReport(), 'Google Chrome');
    finalizeBrowserStartupReport(
      report,
      'failed',
      stage,
      new Error('TimeoutError' + PRIVATE_DETAILS),
    );
    assert.equal(report.stage, stage);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.attempts[0].outcome, 'ready');
    assert.deepEqual(report.failure, { category: 'timeout' });
    assertSafe(report);
    assert.deepEqual(parseBrowserStartupReport(JSON.parse(JSON.stringify(report))), report);
    finalizeBrowserStartupReport(report, 'ready', stage);
    assert.ok(!Object.hasOwn(report, 'failure'));
    assertSafe(report);
  }
});

test('parsing reconstructs only fixed fields at every level and detaches restored data', () => {
  const original = addBrowserAttempt(
    createBrowserStartupReport(),
    'Testloom Chromium',
    new Error(`<process did exit: exitCode=12, signal=SIGABRT>${PRIVATE_DETAILS}`),
  );
  finalizeBrowserStartupReport(original, 'failed', 'setup', new Error('EACCES' + PRIVATE_DETAILS));
  const input = JSON.parse(JSON.stringify(original));
  input.rawError = PRIVATE_DETAILS;
  input.path = PRIVATE_DETAILS;
  input.attempts[0].rawError = PRIVATE_DETAILS;
  input.failure.url = PRIVATE_DETAILS;
  input.__proto__ = { privateData: PRIVATE_DETAILS };
  assert.throws(() => parseBrowserStartupReport(input), {
    message: 'Invalid browser startup report.',
  });
  Object.setPrototypeOf(input, Object.prototype);
  Object.defineProperty(input, '__proto__', {
    value: { privateData: PRIVATE_DETAILS },
    enumerable: true,
  });
  input.constructor = PRIVATE_DETAILS;
  const restored = parseBrowserStartupReport(input);
  assert.deepEqual(restored, original);
  assert.notEqual(restored, input);
  assert.notEqual(restored.attempts, input.attempts);
  assert.notEqual(restored.attempts[0], input.attempts[0]);
  assert.notEqual(restored.failure, input.failure);
  input.attempts[0].signal = PRIVATE_DETAILS;
  input.failure.category = PRIVATE_DETAILS;
  assertSafe(restored);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
});

test('valid persisted outcomes, platforms, architectures and release metadata round trip', () => {
  for (const [platformName, architecture, osVersion] of [
    ['darwin', 'arm64', '25.0.0'],
    ['darwin', 'x64', '23.6.0'],
    ['win32', 'x64', '10.0.22631'],
    ['linux', 'x64', '6.8.0-1021-azure'],
    ['linux', 'arm64', '6.6.87.2-microsoft-standard-WSL2'],
    ['linux', 'riscv64', '6.12.0+custom'],
  ]) {
    const report = createBrowserStartupReport();
    report.platform = platformName;
    report.arch = architecture;
    report.osVersion = osVersion;
    report.appVersion = '0.4.0-beta.1+123';
    for (const outcome of ['ready', 'failed', 'cancelled'] as const) {
      finalizeBrowserStartupReport(report, outcome, 'navigation');
      assert.deepEqual(parseBrowserStartupReport(JSON.parse(JSON.stringify(report))), report);
      assertSafe(report);
    }
  }
});

test('parsing rejects missing, malformed or private metadata with one safe error', () => {
  const valid = createBrowserStartupReport();
  for (const [field, value] of [
    ['schemaVersion', 2],
    ['schemaVersion', '1'],
    ['id', PRIVATE_DETAILS],
    ['id', '00000000-0000-0000-0000-000000000000'],
    ['createdAt', '2026-02-30T12:00:00.000Z'],
    ['createdAt', '2026-09-09'],
    ['createdAt', '2026-09-09T12:00:00.000Z\nPRIVATE_TOKEN'],
    ['appVersion', PRIVATE_DETAILS],
    ['appVersion', 1],
    ['appVersion', '1.0.0/PRIVATE_TOKEN'],
    ['playwrightVersion', '1.63.0\nPRIVATE_TOKEN'],
    ['platform', PRIVATE_DETAILS],
    ['platform', 'Darwin'],
    ['arch', PRIVATE_DETAILS],
    ['osVersion', '/Users/PRIVATE_USER'],
    ['osVersion', '25.0.0 https://PRIVATE_HOST.invalid'],
    ['osVersion', '25.0.0\nPRIVATE_TOKEN'],
    ['osVersion', '1'.repeat(129)],
    ['stage', PRIVATE_DETAILS],
    ['outcome', PRIVATE_DETAILS],
    ['attempts', {}],
    ['attempts', null],
    ['attempts', Array(11).fill({})],
    ['attempts', Array(1)],
    ['failure', null],
  ] as const) {
    assert.throws(() => parseBrowserStartupReport({ ...valid, [field]: value }), {
      message: 'Invalid browser startup report.',
    });
  }
  for (const key of Object.keys(valid)) {
    const input: Record<string, unknown> = { ...valid };
    delete input[key];
    assert.throws(() => parseBrowserStartupReport(input), {
      message: 'Invalid browser startup report.',
    });
  }
  for (const input of [
    null,
    undefined,
    PRIVATE_DETAILS,
    1,
    [],
    new Date(),
    new Error(PRIVATE_DETAILS),
  ])
    assert.throws(() => parseBrowserStartupReport(input), {
      message: 'Invalid browser startup report.',
    });
});

test('parsing validates attempts and top-level failures without coercing unsafe values', () => {
  const report = addBrowserAttempt(
    createBrowserStartupReport(),
    'Microsoft Edge',
    new Error('Target closed'),
  );
  for (const [field, value] of [
    ['browser', PRIVATE_DETAILS],
    ['browser', 'Unknown browser'],
    ['outcome', 'cancelled'],
    ['outcome', 'ready'],
    ['category', PRIVATE_DETAILS],
    ['signal', PRIVATE_DETAILS],
    ['signal', 'SIGKILL PRIVATE_TOKEN'],
    ['signal', 'null'],
    ['signal', null],
    ['exitCode', '12'],
    ['exitCode', 1.5],
    ['exitCode', Infinity],
    ['exitCode', NaN],
    ['exitCode', 2147483648],
    ['exitCode', -2147483649],
    ['exitCode', null],
  ] as const) {
    const input = { ...report, attempts: [{ ...report.attempts[0], [field]: value }] };
    assert.throws(() => parseBrowserStartupReport(input), {
      message: 'Invalid browser startup report.',
    });
  }
  for (const failure of [
    { category: PRIVATE_DETAILS },
    { category: 'closed', signal: PRIVATE_DETAILS },
    { category: 'closed', exitCode: '1' },
    { category: 'closed', rawError: PRIVATE_DETAILS },
  ]) {
    const input = { ...report, failure };
    if ('rawError' in failure) {
      const parsed = parseBrowserStartupReport(input);
      assert.deepEqual(parsed.failure, { category: 'closed' });
      assertSafe(parsed);
    } else {
      assert.throws(() => parseBrowserStartupReport(input), {
        message: 'Invalid browser startup report.',
      });
    }
  }
  for (const outcome of ['ready', 'cancelled'])
    assert.throws(
      () => parseBrowserStartupReport({ ...report, outcome, failure: { category: 'closed' } }),
      {
        message: 'Invalid browser startup report.',
      },
    );
});

test('parsing does not invoke accessors or custom array iterators and never forwards thrown secrets', () => {
  let getterCalled = false;
  const report = createBrowserStartupReport();
  const input = {
    ...report,
    get signal() {
      getterCalled = true;
      throw new Error(PRIVATE_DETAILS);
    },
  };
  assert.throws(() => parseBrowserStartupReport(input), {
    message: 'Invalid browser startup report.',
  });
  assert.equal(getterCalled, false);
  const attempts: unknown[] = [];
  Object.defineProperty(attempts, '0', {
    get() {
      getterCalled = true;
      return {};
    },
  });
  assert.throws(() => parseBrowserStartupReport({ ...report, attempts }), {
    message: 'Invalid browser startup report.',
  });
  assert.equal(getterCalled, false);
  const validAttempts = [{ browser: 'Testloom Chromium', outcome: 'ready', category: 'unknown' }];
  validAttempts[Symbol.iterator] = () => {
    throw new Error(PRIVATE_DETAILS);
  };
  const parsed = parseBrowserStartupReport({ ...report, attempts: validAttempts });
  assert.equal(parsed.attempts.length, 1);
  assertSafe(parsed);
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(PRIVATE_DETAILS);
      },
    },
  );
  assert.throws(() => parseBrowserStartupReport(proxy), {
    message: 'Invalid browser startup report.',
  });
});
