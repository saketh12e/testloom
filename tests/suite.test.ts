import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneCase,
  createCase,
  serializeSuite,
  validateCase,
  validateSuite,
} from '../src/core/suite';
import { portableGenerate } from '../src/core/generator';
import type { CaseKind, Project, Scenario, TestCase } from '../src/shared/types';

const date = '2026-09-07T12:00:00.000Z';
function scenario(): Scenario {
  return {
    schemaVersion: 1,
    id: 'recording-1',
    name: 'Apply a discount',
    startUrl: 'http://localhost:4318/',
    createdAt: date,
    events: [
      {
        id: 'event-1',
        sequence: 1,
        timestamp: date,
        action: 'navigate',
        url: 'http://localhost:4318/',
        pageId: 'page-1',
        label: 'Open cart',
        locators: [],
      },
      {
        id: 'event-2',
        sequence: 2,
        timestamp: date,
        action: 'fill',
        url: 'http://localhost:4318/',
        pageId: 'page-1',
        label: 'Coupon',
        locators: [{ strategy: 'label', value: 'Coupon' }],
        value: 'SAVE10',
        redacted: false,
        warnings: [],
        frameSelectors: [],
      },
    ],
    assertions: [
      {
        id: 'requirement-1',
        description: 'The discounted total must be $90.00',
        kind: 'text',
        locator: { strategy: 'testId', value: 'total' },
        expected: '$90.00',
        source: 'user',
      },
    ],
    warnings: [],
    network: [{ method: 'GET', url: 'http://localhost:4318/cart', status: 200 }],
  };
}
function draft(): TestCase {
  const source = scenario();
  source.events = [];
  source.assertions = [];
  return createCase(source);
}
const suite = (cases: unknown[]) => ({ schemaVersion: 2, name: 'Testloom suite', cases });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('creating cases preserves recording provenance and gives each generated output its own identity', () => {
  const source = scenario();
  const original = structuredClone(source);
  const first = createCase(source);
  const second = createCase(source, 'negative');
  assert.match(first.id, uuid);
  assert.match(second.id, uuid);
  assert.notEqual(first.id, second.id);
  assert.equal(first.scenario.id, first.id);
  assert.equal(second.scenario.id, second.id);
  assert.equal(first.recordingId, source.id);
  assert.equal(second.recordingId, source.id);
  assert.equal(first.kind, 'positive');
  assert.equal(first.priority, 'normal');
  assert.equal(first.enabled, true);
  assert.deepEqual(first.tags, []);
  assert.deepEqual(second.scenario.assertions, source.assertions);
  const project: Project = {
    id: 'project',
    name: 'cart',
    path: '/unused',
    framework: 'playwright-ts',
    buildTool: 'npm',
    summary: '',
    examples: [],
    commands: [],
    outputDir: 'tests/generated',
  };
  const outputs = [first, second].map((item) => portableGenerate(project, item.scenario).files[0]);
  assert.notEqual(outputs[0].path, outputs[1].path);
  outputs.forEach((output) => assert.ok(output.content.includes('toHaveText("$90.00")')));
  first.scenario.events[1].locators[0].value = 'Changed';
  first.scenario.network[0].status = 500;
  assert.deepEqual(source, original);
  assert.equal(second.scenario.events[1].locators[0].value, 'Coupon');
});

test('copying into each kind changes only case identity, copy name, kind and update time', () => {
  const source = createCase(scenario());
  source.tags = ['cart'];
  source.priority = 'high';
  source.enabled = false;
  source.updatedAt = date;
  const before = structuredClone(source);
  for (const kind of ['positive', 'negative', 'boundary'] as CaseKind[]) {
    const copy = cloneCase(source, kind);
    assert.match(copy.id, uuid);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.scenario.id, copy.id);
    assert.equal(copy.recordingId, source.recordingId);
    assert.equal(copy.name, `${source.name} (copy)`);
    assert.equal(copy.scenario.name, copy.name);
    assert.equal(copy.kind, kind);
    assert.equal(copy.priority, 'high');
    assert.equal(copy.enabled, false);
    assert.deepEqual(copy.scenario.assertions, before.scenario.assertions);
    assert.deepEqual(copy.scenario.events, before.scenario.events);
    copy.scenario.assertions[0].expected = 'User edited';
    copy.tags.push('copy');
    assert.deepEqual(source, before);
  }
  source.name = 'x'.repeat(120);
  assert.equal(cloneCase(source, 'boundary').name.length, 120);
});

test('empty drafts and empty suites remain editable; validation returns detached nested objects', () => {
  assert.deepEqual(validateSuite(JSON.stringify(suite([]))), []);
  const source = draft();
  assert.deepEqual(validateSuite(suite([source])), [source]);
  const copy = validateCase(source);
  copy.tags.push('edited');
  copy.scenario.warnings.push('Review');
  assert.deepEqual(source.tags, []);
  assert.deepEqual(source.scenario.warnings, []);
});

test('JSON and object round trips preserve ordinary requirements and remove every screenshot path', () => {
  const source = createCase(scenario());
  source.scenario.events[0].screenshot = '/private/workspace/customer.png';
  source.scenario.events[1].screenshot = '../../outside/credentials.json';
  source.scenario.assertions[0].expected =
    '$90.00 — 10% off; use "SAVE10"\nNo discount on shipping.';
  source.scenario.assertions.push({
    id: 'url-check',
    source: 'user',
    kind: 'url',
    description: 'Cart search URL',
    expected: 'https://example.com/cart?q=coat%20hanger&discount=10%25#summary',
  });
  const before = structuredClone(source);
  assert.equal(
    validateCase(source).scenario.events[0].screenshot,
    before.scenario.events[0].screenshot,
  );
  const exported = serializeSuite([source]);
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.name, 'Testloom suite');
  assert.ok(!JSON.stringify(exported).includes('screenshot'));
  assert.ok(!JSON.stringify(exported).includes('/private/workspace'));
  assert.deepEqual(validateSuite(exported), exported.cases);
  assert.deepEqual(validateSuite(JSON.stringify(exported)), exported.cases);
  assert.deepEqual(exported.cases[0].scenario.assertions, source.scenario.assertions);
  assert.deepEqual(source, before);
  const imported = validateSuite(suite([source]));
  imported[0].scenario.events.forEach((item) =>
    assert.equal(Object.hasOwn(item, 'screenshot'), false),
  );
});

test('exports scrub secret-bearing text and mark changed input values redacted without mutating requirements in memory', () => {
  const source = createCase(scenario());
  const secret = 'sk-SYNTHETIC_SECRET_123456789';
  source.name = `Token ${secret}`;
  source.scenario.name = source.name;
  source.tags = [secret];
  source.scenario.events[1].value = secret;
  source.scenario.events[1].label = `api_key=${secret}`;
  source.scenario.events[1].locators[0].name = secret;
  source.scenario.events[1].frameSelectors = [`[data-token="${secret}"]`];
  source.scenario.events[1].warnings = [secret];
  source.scenario.warnings = [secret];
  source.scenario.assertions[0].description = `No exposure of ${secret}`;
  source.scenario.assertions[0].expected = `{"password":"${secret}"}`;
  source.scenario.assertions[0].locator!.value = secret;
  const before = structuredClone(source);
  const exported = serializeSuite([source]);
  assert.ok(!JSON.stringify(exported).includes('SYNTHETIC_SECRET'));
  assert.deepEqual(source, before);
  assert.equal(exported.cases[0].scenario.events[1].value, '[REDACTED]');
  assert.equal(exported.cases[0].scenario.events[1].redacted, true);
  assert.deepEqual(serializeSuite(validateSuite(JSON.stringify(exported))), exported);
});

test('an existing redaction flag masks even an ordinary-looking supplied secret while safe keys survive', () => {
  const source = createCase(scenario());
  source.scenario.events[1].redacted = true;
  source.scenario.events[1].value = 'do-not-share';
  assert.equal(validateCase(source).scenario.events[1].value, '[REDACTED]');
  assert.equal(validateSuite(suite([source]))[0].scenario.events[1].value, '[REDACTED]');
  source.scenario.events[1].action = 'press';
  source.scenario.events[1].value = 'Control+Enter';
  assert.equal(serializeSuite([source]).cases[0].scenario.events[1].value, 'Control+Enter');
});

test('suite identity checks include disabled cases and distinguish recording provenance from output IDs', () => {
  const first = createCase(scenario());
  const second = cloneCase(first, 'negative');
  second.enabled = false;
  assert.equal(validateSuite(suite([first, second])).length, 2);
  assert.throws(() => validateSuite(suite([first, first])), /duplicate IDs/);
  second.scenario.id = first.scenario.id;
  assert.throws(() => validateSuite(suite([first, second])), /duplicate IDs/);
  assert.throws(() => serializeSuite([first, first]), /duplicate IDs/);
});

test('unsafe IDs cannot become filesystem paths, and missing or unknown fields are rejected', () => {
  for (const id of [
    '',
    '../escape',
    'a/b',
    'a\\b',
    '/tmp/file',
    'C:drive',
    'a%2fb',
    '.',
    'x\n',
    'x'.repeat(129),
  ]) {
    for (const mutate of [
      (item: TestCase) => {
        item.id = id;
      },
      (item: TestCase) => {
        item.recordingId = id;
      },
      (item: TestCase) => {
        item.scenario.id = id;
      },
      (item: TestCase) => {
        item.scenario.events[0].id = id;
      },
      (item: TestCase) => {
        item.scenario.events[0].pageId = id;
      },
      (item: TestCase) => {
        item.scenario.assertions[0].id = id;
      },
    ]) {
      const item = createCase(scenario());
      mutate(item);
      assert.throws(() => validateCase(item));
    }
  }
  const complete = createCase(scenario());
  for (const key of Object.keys(complete)) {
    const item: any = structuredClone(complete);
    delete item[key];
    assert.throws(() => validateCase(item), key);
  }
  for (const key of Object.keys(complete.scenario)) {
    const item: any = structuredClone(complete);
    delete item.scenario[key];
    assert.throws(() => validateCase(item), key);
  }
  assert.throws(
    () => validateSuite({ ...suite([complete]), workspaceRoot: '/private/root' }),
    /unexpected field/,
  );
  assert.throws(
    () => serializeSuite([{ ...complete, workspaceRoot: '/private/root' } as TestCase]),
    /unexpected field/,
  );
  assert.throws(() => validateCase(JSON.parse('{"__proto__":{}}')), /unexpected field/);
  assert.throws(() => validateCase(Object.create(complete)));
});

test('every existing field is checked even in drafts or disabled cases', () => {
  const corruptions: ((item: any) => void)[] = [
    (x) => {
      x.kind = 'failure';
    },
    (x) => {
      x.priority = 'urgent';
    },
    (x) => {
      x.enabled = 'false';
    },
    (x) => {
      x.tags = 'cart';
    },
    (x) => {
      x.tags = [null];
    },
    (x) => {
      x.name = '';
    },
    (x) => {
      x.updatedAt = 'yesterday';
    },
    (x) => {
      x.scenario.createdAt = '2026-02-30T00:00:00Z';
    },
    (x) => {
      x.scenario.schemaVersion = 2;
    },
    (x) => {
      x.scenario.warnings = [42];
    },
    (x) => {
      x.scenario.network[0].status = 600;
    },
    (x) => {
      x.scenario.network[0].status = 200.5;
    },
    (x) => {
      x.scenario.network[0].method = 'GET\nX-Header';
    },
    (x) => {
      x.scenario.events[1].action = 'execute';
    },
    (x) => {
      x.scenario.events[1].value = 123;
    },
    (x) => {
      x.scenario.events[1].redacted = 'true';
    },
    (x) => {
      x.scenario.events[1].locators = [];
    },
    (x) => {
      delete x.scenario.events[1].value;
    },
    (x) => {
      x.scenario.events[1].locators[0].strategy = 'xpath';
    },
    (x) => {
      x.scenario.events[1].locators[0].value = '';
    },
    (x) => {
      x.scenario.events[1].locators[0].name = {};
    },
    (x) => {
      x.scenario.events[1].locators[0] = { strategy: 'role', value: 'button()' };
    },
    (x) => {
      x.scenario.events[1].locators[0].executable = 'rm';
    },
    (x) => {
      x.scenario.events[1].frameSelectors = [null];
    },
    (x) => {
      x.scenario.events[1].warnings = false;
    },
    (x) => {
      x.scenario.events[1].screenshot = 7;
    },
    (x) => {
      x.scenario.events[1].sequence = 1;
    },
    (x) => {
      x.scenario.events[1].sequence = NaN;
    },
    (x) => {
      x.scenario.events[1].timestamp = '';
    },
    (x) => {
      x.scenario.events[1].id = x.scenario.events[0].id;
    },
    (x) => {
      x.scenario.events[1].action = 'press';
      x.scenario.events[1].value = 'runShell';
    },
    (x) => {
      x.scenario.assertions[0].source = 'agent';
    },
    (x) => {
      x.scenario.assertions[0].expected = false;
    },
    (x) => {
      x.scenario.assertions[0].kind = 'truthy';
    },
    (x) => {
      x.scenario.assertions[0].description = '';
    },
    (x) => {
      delete x.scenario.assertions[0].locator;
    },
    (x) => {
      x.scenario.assertions.push(x.scenario.assertions[0]);
    },
  ];
  for (const mutate of corruptions) {
    const item = createCase(scenario());
    item.enabled = false;
    mutate(item);
    assert.throws(() => validateCase(item), mutate.toString());
    assert.throws(() => validateSuite(suite([item])), mutate.toString());
  }
  const item = draft();
  item.tags = Array(1);
  assert.throws(() => validateCase(item));
  assert.throws(() => validateSuite(suite(Array(1))));
  for (const input of [
    null,
    [],
    {},
    '{',
    suite([null]),
    { ...suite([]), schemaVersion: 1 },
    { ...suite([]), name: 3 },
  ])
    assert.throws(() => validateSuite(input));
});

test('unsafe and secret URLs are rejected in start URLs, events, network and URL requirements', () => {
  const urls = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    '//example.com/path',
    'https:\\example.com/path',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://example.com/?token=private',
    'https://example.com/?%61pi_key=private',
    'https://example.com/#access_token=private',
    'https://example.com/?%2574oken=private',
    'https://example.com/?password=private',
    'https://example.com/sk-SYNTHETIC_SECRET_123456789',
    'https://example.com/?q=sk-SYNTHETIC_SECRET_123456789',
    'https://example.com/%00',
    'https://example.com/\npath',
  ];
  for (const url of urls)
    for (const field of ['start', 'event', 'network', 'assertion']) {
      const item = createCase(scenario());
      if (field === 'start') item.scenario.startUrl = url;
      if (field === 'event') item.scenario.events[0].url = url;
      if (field === 'network') item.scenario.network[0].url = url;
      if (field === 'assertion')
        item.scenario.assertions[0] = {
          ...item.scenario.assertions[0],
          kind: 'url',
          expected: url,
        };
      assert.throws(() => validateSuite(suite([item])), `${field}: ${url}`);
      assert.throws(() => serializeSuite([item]), `${field}: ${url}`);
    }
});

test('limits accept their boundary and reject oversized fields, collections and UTF-8 suite payloads', () => {
  const item = createCase(scenario());
  item.name = item.scenario.name = 'n'.repeat(120);
  item.tags = Array(12).fill('t'.repeat(40));
  item.scenario.events = Array.from({ length: 500 }, (_, index) => ({
    ...item.scenario.events[0],
    id: `event-${index}`,
    sequence: index + 1,
  }));
  item.scenario.assertions = Array.from({ length: 30 }, (_, index) => ({
    ...item.scenario.assertions[0],
    id: `assertion-${index}`,
  }));
  assert.equal(validateCase(item).scenario.events.length, 500);
  const corruptions: ((item: any) => void)[] = [
    (x) => {
      x.name += 'n';
    },
    (x) => {
      x.scenario.name += 'n';
    },
    (x) => {
      x.tags.push('extra');
    },
    (x) => {
      x.tags[0] += 't';
    },
    (x) => {
      x.scenario.events.push(x.scenario.events[0]);
    },
    (x) => {
      x.scenario.assertions.push(x.scenario.assertions[0]);
    },
    (x) => {
      x.scenario.events[0].value = 'x'.repeat(8193);
    },
    (x) => {
      x.scenario.events[0].locators = Array(9).fill({ strategy: 'text', value: 'ok' });
    },
    (x) => {
      x.scenario.events[0].locators = [{ strategy: 'text', value: 'x'.repeat(2049) }];
    },
    (x) => {
      x.scenario.events[0].label = 'x'.repeat(513);
    },
    (x) => {
      x.scenario.warnings = Array(65).fill('Review');
    },
    (x) => {
      x.scenario.network = Array(2001).fill(x.scenario.network[0]);
    },
    (x) => {
      x.scenario.assertions[0].expected = 'x'.repeat(8193);
    },
  ];
  for (const mutate of corruptions) {
    const copy = structuredClone(item);
    mutate(copy);
    assert.throws(() => validateCase(copy), mutate.toString());
  }
  const cases = Array.from({ length: 500 }, () => draft());
  assert.equal(validateSuite(suite(cases)).length, 500);
  assert.throws(() => validateSuite(suite([...cases, draft()])), /500/);
  const json = JSON.stringify(suite([]));
  const maxBytes = 5 * 1024 * 1024;
  assert.deepEqual(validateSuite(json + ' '.repeat(maxBytes - Buffer.byteLength(json))), []);
  assert.throws(
    () => validateSuite(json + ' '.repeat(maxBytes - Buffer.byteLength(json)) + '\n'),
    /5 MB/,
  );
  const huge = draft();
  huge.scenario.events = Array.from({ length: 250 }, (_, index) => ({
    ...scenario().events[1],
    id: `e-${index}`,
    sequence: index + 1,
    value: '界'.repeat(8192),
  }));
  assert.ok(JSON.stringify(suite([huge])).length < maxBytes);
  assert.throws(() => validateSuite(suite([huge])), /5 MB/);
  assert.throws(() => serializeSuite([huge]), /5 MB/);
});
