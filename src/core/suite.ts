import { randomUUID } from 'node:crypto';
import type {
  Assertion,
  CaseKind,
  InteractionEvent,
  LocatorSpec,
  Scenario,
  TestCase,
} from '../shared/types';
import { scrubText } from './repository';

const MAX_BYTES = 5 * 1024 * 1024;
const KINDS = ['positive', 'negative', 'boundary'] as const;
const ACTIONS = [
  'navigate',
  'click',
  'fill',
  'check',
  'uncheck',
  'select',
  'press',
  'popup',
  'note',
] as const;
const STRATEGIES = ['testId', 'role', 'label', 'placeholder', 'text', 'css'] as const;
const REDACTED = '[REDACTED]';
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function invalid(field: string, reason: string): never {
  throw new Error(`Invalid ${field}: ${reason}.`);
}
function record(input: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid(field, 'expected an object');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      invalid(field, 'unexpected field');
  }
  return input as Record<string, unknown>;
}
function text(input: unknown, field: string, limit: number, empty = false): string {
  if (
    typeof input !== 'string' ||
    input.length > limit ||
    CONTROL.test(input) ||
    (!empty && !input.trim())
  )
    invalid(field, `expected ${empty ? 'a' : 'a nonempty'} string of at most ${limit} characters`);
  return input;
}
function identity(input: unknown, field: string): string {
  const value = text(input, field, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))
    invalid(field, 'use letters, numbers, underscores or hyphens for IDs');
  return value;
}
function choice<T extends string>(input: unknown, field: string, values: readonly T[]): T {
  if (typeof input !== 'string' || !values.includes(input as T))
    invalid(field, `expected ${values.join(', ')}`);
  return input as T;
}
function boolean(input: unknown, field: string): boolean {
  if (typeof input !== 'boolean') invalid(field, 'expected a boolean');
  return input;
}
function integer(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max)
    invalid(field, `expected an integer from ${min} to ${max}`);
  return input;
}
function list<T>(
  input: unknown,
  field: string,
  max: number,
  parse: (item: unknown, field: string) => T,
): T[] {
  if (!Array.isArray(input) || input.length > max)
    invalid(field, `expected an array with at most ${max} entries`);
  // Array.from visits holes too; sparse arrays must not bypass validation.
  return Array.from(input, (item, index) => parse(item, `${field}[${index}]`));
}
function timestamp(input: unknown, field: string): string {
  const value = text(input, field, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid(field, 'expected an ISO timestamp with a timezone');
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    invalid(field, 'invalid calendar date');
  return value;
}
function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(field, 'duplicate IDs');
}
function boundedSize(input: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    invalid('suite', 'expected serializable JSON');
  }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BYTES)
    invalid('suite', 'maximum size is 5 MB');
}

function safeUrl(input: unknown, field: string, empty = false): string {
  const value = text(input, field, 8192, empty);
  if (empty && !value) return value;
  if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value))
    invalid(field, 'use an HTTP or HTTPS URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(field, 'invalid URL');
  }
  if (!url.hostname || url.username || url.password)
    invalid(field, 'URLs must not contain credentials');
  // Decode before inspecting so percent-encoded keys and token values cannot hide secrets.
  let decoded = value;
  for (let index = 0; index < 4; index++) {
    if (index > 0 && !/%[0-9a-f]{2}/i.test(decoded)) break;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      invalid(field, 'invalid URL encoding');
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) invalid(field, 'invalid URL characters');
  const secretKey =
    /(?:^|[?&#;/])(?:[^?&#;/=]*(?:password|passwd|passphrase|secret|token|credential|authorization|api[_-]?key|session[_-]?id)|auth|key|jwt|signature|sig|code)=/i;
  if (
    secretKey.test(decoded) ||
    scrubText(decoded) !== decoded ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(decoded)
  )
    invalid(field, 'URLs must not contain secrets');
  return value;
}
function locator(input: unknown, field: string): LocatorSpec {
  const source = record(input, field, ['strategy', 'value', 'name']);
  const strategy = choice(source.strategy, `${field}.strategy`, STRATEGIES);
  const value = text(source.value, `${field}.value`, 2048);
  if (strategy === 'role' && !/^[a-z]+$/.test(value)) invalid(field, 'invalid accessibility role');
  return {
    strategy,
    value,
    ...(source.name !== undefined ? { name: text(source.name, `${field}.name`, 512, true) } : {}),
  };
}
const warnings = (input: unknown, field: string) =>
  list(input, field, 64, (item, name) => text(item, name, 2000));

function event(input: unknown, field: string, stripScreenshots: boolean): InteractionEvent {
  const source = record(input, field, [
    'id',
    'sequence',
    'timestamp',
    'action',
    'url',
    'pageId',
    'label',
    'locators',
    'value',
    'redacted',
    'screenshot',
    'frameSelectors',
    'warnings',
  ]);
  const action = choice(source.action, `${field}.action`, ACTIONS);
  const locators = list(source.locators, `${field}.locators`, 8, locator);
  if (!['navigate', 'popup', 'note'].includes(action) && !locators.length)
    invalid(field, 'this action needs a locator');
  const value =
    source.value === undefined ? undefined : text(source.value, `${field}.value`, 8192, true);
  const redacted =
    source.redacted === undefined ? undefined : boolean(source.redacted, `${field}.redacted`);
  if (['fill', 'select', 'press'].includes(action) && value === undefined)
    invalid(field, 'this action needs a value');
  if (
    action === 'press' &&
    (value!.length > 128 ||
      !/^(?:(?:Control|Alt|Meta|Shift)\+)*(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Space|Backspace|Delete|Insert|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(
        value!,
      ))
  )
    invalid(field, 'invalid keyboard action');
  const screenshot =
    source.screenshot === undefined
      ? undefined
      : text(source.screenshot, `${field}.screenshot`, 4096);
  return {
    id: identity(source.id, `${field}.id`),
    sequence: integer(source.sequence, `${field}.sequence`, 1, 500),
    timestamp: timestamp(source.timestamp, `${field}.timestamp`),
    action,
    url: safeUrl(source.url, `${field}.url`, action === 'note' || action === 'popup'),
    pageId: identity(source.pageId, `${field}.pageId`),
    label: text(source.label, `${field}.label`, 512, true),
    locators,
    ...(value !== undefined ? { value: redacted && action !== 'press' ? REDACTED : value } : {}),
    ...(redacted !== undefined ? { redacted } : {}),
    ...(!stripScreenshots && screenshot !== undefined ? { screenshot } : {}),
    ...(source.frameSelectors !== undefined
      ? {
          frameSelectors: list(source.frameSelectors, `${field}.frameSelectors`, 8, (item, name) =>
            text(item, name, 2048),
          ),
        }
      : {}),
    ...(source.warnings !== undefined
      ? { warnings: warnings(source.warnings, `${field}.warnings`) }
      : {}),
  };
}
function assertion(input: unknown, field: string): Assertion {
  const source = record(input, field, [
    'id',
    'description',
    'kind',
    'locator',
    'expected',
    'source',
  ]);
  const kind = choice(source.kind, `${field}.kind`, ['text', 'visible', 'url', 'custom'] as const);
  const target =
    source.locator === undefined ? undefined : locator(source.locator, `${field}.locator`);
  if ((kind === 'text' || kind === 'visible') && !target)
    invalid(field, 'this assertion needs a locator');
  return {
    id: identity(source.id, `${field}.id`),
    description: text(source.description, `${field}.description`, 2000),
    kind,
    ...(target ? { locator: target } : {}),
    expected:
      kind === 'url'
        ? safeUrl(source.expected, `${field}.expected`)
        : text(source.expected, `${field}.expected`, 8192, kind === 'visible' || kind === 'text'),
    source: choice(source.source, `${field}.source`, ['user'] as const),
  };
}
function parseScenario(input: unknown, stripScreenshots: boolean): Scenario {
  const source = record(input, 'scenario', [
    'schemaVersion',
    'id',
    'name',
    'startUrl',
    'createdAt',
    'events',
    'assertions',
    'warnings',
    'network',
  ]);
  if (source.schemaVersion !== 1) invalid('scenario.schemaVersion', 'expected 1');
  const events = list(source.events, 'scenario.events', 500, (item, name) =>
    event(item, name, stripScreenshots),
  );
  unique(
    events.map((item) => item.id),
    'scenario.events',
  );
  if (events.some((item, index) => index > 0 && item.sequence <= events[index - 1].sequence))
    invalid('scenario.events', 'sequences must increase in recording order');
  const assertions = list(source.assertions, 'scenario.assertions', 30, assertion);
  unique(
    assertions.map((item) => item.id),
    'scenario.assertions',
  );
  return {
    schemaVersion: 1,
    id: identity(source.id, 'scenario.id'),
    name: text(source.name, 'scenario.name', 120),
    startUrl: safeUrl(source.startUrl, 'scenario.startUrl'),
    createdAt: timestamp(source.createdAt, 'scenario.createdAt'),
    events,
    assertions,
    warnings: warnings(source.warnings, 'scenario.warnings'),
    network: list(source.network, 'scenario.network', 2000, (input, field) => {
      const entry = record(input, field, ['method', 'url', 'status']);
      const method = text(entry.method, `${field}.method`, 32);
      if (!/^[A-Z]+$/.test(method)) invalid(field, 'invalid HTTP method');
      return {
        method,
        url: safeUrl(entry.url, `${field}.url`),
        status: integer(entry.status, `${field}.status`, 0, 599),
      };
    }),
  };
}

function parseCase(input: unknown, stripScreenshots: boolean): TestCase {
  const source = record(input, 'case', [
    'id',
    'name',
    'kind',
    'priority',
    'tags',
    'enabled',
    'recordingId',
    'scenario',
    'updatedAt',
  ]);
  return {
    id: identity(source.id, 'case.id'),
    name: text(source.name, 'case.name', 120),
    kind: choice(source.kind, 'case.kind', KINDS),
    priority: choice(source.priority, 'case.priority', [
      'critical',
      'high',
      'normal',
      'low',
    ] as const),
    tags: list(source.tags, 'case.tags', 12, (item, field) => text(item, field, 40)),
    enabled: boolean(source.enabled, 'case.enabled'),
    recordingId: identity(source.recordingId, 'case.recordingId'),
    scenario: parseScenario(source.scenario, stripScreenshots),
    updatedAt: timestamp(source.updatedAt, 'case.updatedAt'),
  };
}

export function createCase(scenario: Scenario, kind: CaseKind = 'positive'): TestCase {
  const id = randomUUID();
  return validateCase({
    id,
    name: scenario.name,
    kind,
    priority: 'normal',
    tags: [],
    enabled: true,
    recordingId: scenario.id,
    scenario: { ...structuredClone(scenario), id },
    updatedAt: new Date().toISOString(),
  });
}

export function cloneCase(testcase: TestCase, kind: CaseKind): TestCase {
  const copy = validateCase(testcase);
  const id = randomUUID();
  const name = `${copy.name.slice(0, 113)} (copy)`;
  // Requirements and recorded evidence retain their IDs and meaning; kind is metadata.
  return {
    ...copy,
    id,
    kind: choice(kind, 'case.kind', KINDS),
    name,
    scenario: { ...copy.scenario, id, name },
    updatedAt: new Date().toISOString(),
  };
}

/** Validate editable drafts without requiring that generation is already possible. */
export function validateCase(input: unknown): TestCase {
  const result = parseCase(input, false);
  boundedSize(result);
  return result;
}

/** Import untrusted JSON. Screenshot paths never cross this boundary. */
export function validateSuite(input: unknown): TestCase[] {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) invalid('suite', 'maximum size is 5 MB');
    try {
      input = JSON.parse(input);
    } catch {
      invalid('suite', 'expected valid JSON');
    }
  }
  const source = record(input, 'suite', ['schemaVersion', 'name', 'cases']);
  if (source.schemaVersion !== 2) invalid('suite.schemaVersion', 'expected 2');
  text(source.name, 'suite.name', 120);
  boundedSize(source);
  const cases = list(source.cases, 'suite.cases', 500, (item) => parseCase(item, true));
  unique(
    cases.map((item) => item.id),
    'suite.cases',
  );
  unique(
    cases.map((item) => item.scenario.id),
    'suite.scenarios',
  );
  return cases;
}

function scrubLocator(input: LocatorSpec): LocatorSpec {
  return {
    ...input,
    value: scrubText(input.value),
    ...(input.name !== undefined ? { name: scrubText(input.name) } : {}),
  };
}
function scrubCase(input: TestCase): TestCase {
  // Build from the validated public shape; no workspace or private root metadata is exported.
  const copy = parseCase(input, true);
  copy.name = scrubText(copy.name);
  copy.tags = copy.tags.map(scrubText);
  copy.scenario.name = scrubText(copy.scenario.name);
  copy.scenario.warnings = copy.scenario.warnings.map(scrubText);
  for (const entry of copy.scenario.events) {
    entry.label = scrubText(entry.label);
    entry.locators = entry.locators.map(scrubLocator);
    if (entry.value !== undefined) {
      const cleaned = scrubText(entry.value);
      if (cleaned !== entry.value || cleaned.includes(REDACTED)) entry.redacted = true;
      entry.value = entry.redacted && entry.action !== 'press' ? REDACTED : cleaned;
    }
    if (entry.frameSelectors) entry.frameSelectors = entry.frameSelectors.map(scrubText);
    if (entry.warnings) entry.warnings = entry.warnings.map(scrubText);
  }
  for (const requirement of copy.scenario.assertions) {
    requirement.description = scrubText(requirement.description);
    requirement.expected = scrubText(requirement.expected);
    if (requirement.locator) requirement.locator = scrubLocator(requirement.locator);
  }
  return copy;
}

export function serializeSuite(cases: TestCase[]): {
  schemaVersion: 2;
  name: 'Testloom suite';
  cases: TestCase[];
} {
  const result = {
    schemaVersion: 2 as const,
    name: 'Testloom suite' as const,
    cases: list(cases, 'suite.cases', 500, (item) => scrubCase(item as TestCase)),
  };
  // Enforce the same size, identity and field rules on both sides of a round trip.
  result.cases = validateSuite(result);
  return result;
}
