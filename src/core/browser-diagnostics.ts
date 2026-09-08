import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import appPackage from '../../package.json';
import playwrightPackage from 'playwright/package.json';

export type BrowserStartupStage = 'browser' | 'setup' | 'navigation';
export type BrowserStartupOutcome = 'ready' | 'failed' | 'cancelled';
export type BrowserFailureCategory =
  'closed' | 'missing' | 'policy' | 'permission' | 'timeout' | 'incompatible' | 'unknown';

// Runtime validation also protects callers outside TypeScript from leaking a path as a label.
export const BROWSER_DIAGNOSTIC_LABELS = [
  'Testloom Chromium',
  'Playwright Chromium',
  'Google Chrome',
  'Microsoft Edge',
] as const;
export type BrowserDiagnosticLabel = (typeof BROWSER_DIAGNOSTIC_LABELS)[number];

export interface BrowserFailure {
  category: BrowserFailureCategory;
  exitCode?: number;
  signal?: string;
}

export interface BrowserStartupAttempt extends BrowserFailure {
  browser: BrowserDiagnosticLabel;
  outcome: 'ready' | 'failed';
}

export interface BrowserStartupReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  appVersion: string;
  playwrightVersion: string;
  platform: string;
  arch: string;
  osVersion: string;
  stage: BrowserStartupStage;
  outcome: BrowserStartupOutcome;
  attempts: BrowserStartupAttempt[];
  failure?: BrowserFailure;
}

export const MAX_BROWSER_STARTUP_ATTEMPTS = 10;
const MAX_ERROR_TEXT = 128 * 1024;
const SIGNALS = new Set([
  'SIGABRT',
  'SIGALRM',
  'SIGBREAK',
  'SIGBUS',
  'SIGCHLD',
  'SIGCONT',
  'SIGEMT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGIO',
  'SIGIOT',
  'SIGKILL',
  'SIGPIPE',
  'SIGPROF',
  'SIGPWR',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSTKFLT',
  'SIGSTOP',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGUSR1',
  'SIGUSR2',
  'SIGVTALRM',
  'SIGWINCH',
  'SIGXCPU',
  'SIGXFSZ',
]);

function errorText(error: unknown): string {
  try {
    const text = String(error);
    // The headline and final process exit are useful; the middle can be enormous.
    return text.length <= MAX_ERROR_TEXT
      ? text
      : `${text.slice(0, MAX_ERROR_TEXT / 2)}\n${text.slice(-MAX_ERROR_TEXT / 2)}`;
  } catch {
    return '';
  }
}

function categoryFor(detail: string): BrowserFailureCategory {
  if (/\bTESTLOOM_(?:BUNDLE_INVALID|MACOS_UNSUPPORTED)\b/.test(detail)) return 'incompatible';
  // Only explicit restrictions qualify. A closed browser is not evidence of device policy.
  if (
    /\bERR_BLOCKED_BY_(?:ADMINISTRATOR|POLICY)\b|\b(?:devtools|developer tools)\s+(?:(?:is|are|has been|have been)\s+)?(?:disabled|disallowed|blocked)\b|\bremote debugging\s+(?:(?:is|has been)\s+)?(?:disabled|disallowed|blocked|not allowed)\s+by\s+(?:(?:an?\s+)?(?:enterprise|administrator|administrative|device|managed)\s+)?policy\b|\bRemoteDebuggingAllowed\s*(?:=|:)\s*false\b|\bDeveloperToolsAvailability\s*(?:=|:)\s*2\b/i.test(
      detail,
    )
  )
    return 'policy';

  if (
    /\bincompatible architecture\b|\bwrong architecture\b|\bbad CPU type in executable\b|\bexec format error\b|\bERROR_BAD_EXE_FORMAT\b|\bnot a valid Win32 application\b|\bunsupported (?:platform|operating system|architecture)\b|\brequires?\s+(?:macOS|Mac OS X)\s+[\d.]+(?:\s+or\s+(?:later|newer))?\b|\bbuilt for (?:macOS|Mac OS X)\s+[\d.]+\s+which is newer than running OS\b/i.test(
      detail,
    )
  )
    return 'incompatible';

  // Do not scan browser logs for absence: dyld's "Reason: image not found" is a crash.
  const firstLine = detail.split(/\r?\n/, 1)[0];
  if (
    /\bTESTLOOM_BROWSER_MISSING\b|\bexecutable\s+(?:doesn.t exist|(?:was\s+)?not found)\b|\bdistribution\b[^\r\n]*\bnot found\b|\bbrowser\s+(?:was\s+)?not found\b|\bplease run\b[^\r\n]*\bplaywright install\b/i.test(
      firstLine,
    )
  )
    return 'missing';

  if (/\b(?:EACCES|EPERM)\b|\bpermission denied\b|\boperation not permitted\b/i.test(detail))
    return 'permission';
  if (
    /\bTimeoutError\b|\btimeout\b[^\r\n]*\bexceeded\b|\btimed out\b|\bERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)\b/i.test(
      detail,
    )
  )
    return 'timeout';
  if (
    /\b(?:target|browser|page)\b[^\r\n]*\bclosed\b|\b(?:browser|process)\b[^\r\n]*\b(?:crashed|exited|terminated|disconnected)\b|<process did exit:|\bdyld(?:\[\d+\])?:|\bLibrary not loaded:/i.test(
      detail,
    )
  )
    return 'closed';
  return 'unknown';
}

/** Extract only fixed categories, numeric exit codes, and known signal names. Never copy errors. */
export function classifyBrowserFailure(error: unknown): BrowserFailure {
  const detail = errorText(error);
  const result: BrowserFailure = { category: categoryFor(detail) };
  const exits = detail.matchAll(
    /<process did exit:\s*exitCode=([^,\r\n>]{1,64}),\s*signal=([^\r\n>]{1,64})>/g,
  );
  // Keep fields together from the last exit marker, including a null or invalid final value.
  for (const match of exits) {
    delete result.exitCode;
    delete result.signal;
    const code = match[1].trim();
    if (/^-?\d{1,10}$/.test(code)) {
      const parsed = Number(code);
      if (Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647)
        result.exitCode = parsed;
    }
    const signal = match[2].trim();
    if (SIGNALS.has(signal)) result.signal = signal;
  }
  return result;
}

/** Creates metadata without hostnames, usernames, environment variables, paths, or URL data. */
export function createBrowserStartupReport(
  stage: BrowserStartupStage = 'browser',
): BrowserStartupReport {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    appVersion: appPackage.version,
    playwrightVersion: playwrightPackage.version,
    platform: platform(),
    arch: arch(),
    osVersion: release(),
    stage,
    // Never report success until the caller explicitly finalizes browser readiness.
    outcome: 'failed',
    attempts: [],
  };
}

/** Appends one sanitized attempt in place; omit error for a ready browser. Keeps the first ten. */
export function addBrowserAttempt(
  report: BrowserStartupReport,
  label: string,
  error?: unknown,
): BrowserStartupReport {
  const browser = BROWSER_DIAGNOSTIC_LABELS.find((allowed) => allowed === label);
  if (!browser) throw new Error('Invalid browser diagnostic label.');
  if (report.attempts.length >= MAX_BROWSER_STARTUP_ATTEMPTS) return report;
  report.attempts.push({
    browser,
    outcome: error === undefined ? 'ready' : 'failed',
    ...(error === undefined ? { category: 'unknown' as const } : classifyBrowserFailure(error)),
  });
  return report;
}

/** Updates completion state in place without replacing the report's identity or attempt history. */
export function finalizeBrowserStartupReport(
  report: BrowserStartupReport,
  outcome: BrowserStartupOutcome,
  stage: BrowserStartupStage = report.stage,
  error?: unknown,
): BrowserStartupReport {
  report.outcome = outcome;
  report.stage = stage;
  if (outcome === 'failed' && error !== undefined) report.failure = classifyBrowserFailure(error);
  else delete report.failure;
  return report;
}

function invalidReport(): never {
  throw new Error('Invalid browser startup report.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidReport();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidReport();
  // Snapshot data properties once: accessors must not change a value after validation.
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) invalidReport();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalidReport();
  return value;
}

function patternValue(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value))
    invalidReport();
  return value;
}

function parseFailure(input: unknown): BrowserFailure {
  const value = record(input);
  const result: BrowserFailure = {
    category: enumValue(value.category, [
      'closed',
      'missing',
      'policy',
      'permission',
      'timeout',
      'incompatible',
      'unknown',
    ] as const),
  };
  if (value.exitCode !== undefined) {
    if (
      typeof value.exitCode !== 'number' ||
      !Number.isInteger(value.exitCode) ||
      value.exitCode < -2147483648 ||
      value.exitCode > 2147483647
    )
      invalidReport();
    result.exitCode = value.exitCode;
  }
  if (value.signal !== undefined) {
    if (typeof value.signal !== 'string' || !SIGNALS.has(value.signal)) invalidReport();
    result.signal = value.signal;
  }
  return result;
}

/** Reconstructs persisted JSON from validated fields; unknown keys are never retained. */
export function parseBrowserStartupReport(input: unknown): BrowserStartupReport {
  try {
    const value = record(input);
    if (value.schemaVersion !== 1) invalidReport();
    const id = patternValue(
      value.id,
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
      36,
    );
    const createdAt = patternValue(
      value.createdAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      24,
    );
    if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)
      invalidReport();
    const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    const result: BrowserStartupReport = {
      schemaVersion: 1,
      id,
      createdAt,
      appVersion: patternValue(value.appVersion, version, 64),
      playwrightVersion: patternValue(value.playwrightVersion, version, 64),
      platform: enumValue(value.platform, [
        'aix',
        'android',
        'darwin',
        'freebsd',
        'linux',
        'openbsd',
        'sunos',
        'win32',
      ]),
      arch: enumValue(value.arch, [
        'arm',
        'arm64',
        'ia32',
        'loong64',
        'mips',
        'mipsel',
        'ppc',
        'ppc64',
        'riscv64',
        's390',
        's390x',
        'x64',
      ]),
      // Kernel release, never os.version(), which can include a build machine or user name.
      osVersion: patternValue(value.osVersion, /^\d[0-9A-Za-z._+-]*$/, 128),
      stage: enumValue(value.stage, ['browser', 'setup', 'navigation'] as const),
      outcome: enumValue(value.outcome, ['ready', 'failed', 'cancelled'] as const),
      attempts: [],
    };
    if (!Array.isArray(value.attempts)) invalidReport();
    const length = Object.getOwnPropertyDescriptor(value.attempts, 'length')?.value;
    if (!Number.isInteger(length) || length < 0 || length > MAX_BROWSER_STARTUP_ATTEMPTS)
      invalidReport();
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.attempts, String(index));
      if (!descriptor || !('value' in descriptor)) invalidReport();
      const attempt = record(descriptor.value);
      const outcome = enumValue(attempt.outcome, ['ready', 'failed'] as const);
      const failure = parseFailure(attempt);
      if (
        outcome === 'ready' &&
        (failure.category !== 'unknown' ||
          failure.exitCode !== undefined ||
          failure.signal !== undefined)
      )
        invalidReport();
      result.attempts.push({
        browser: enumValue(attempt.browser, BROWSER_DIAGNOSTIC_LABELS),
        outcome,
        ...failure,
      });
    }
    if (value.failure !== undefined) {
      if (result.outcome !== 'failed') invalidReport();
      result.failure = parseFailure(value.failure);
    }
    return result;
  } catch {
    // Malformed objects can throw from getters. Do not forward their error text either.
    return invalidReport();
  }
}
