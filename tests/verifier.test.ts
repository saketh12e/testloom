import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectPlaywrightReport, validateCommand, verifyWorkspace } from '../src/core/verifier';

const file = 'tests/generated/cart.spec.ts';
function passed(projectName = 'chromium'): any {
  return {
    projectName,
    expectedStatus: 'passed',
    status: 'expected',
    results: [{ status: 'passed', retry: 0, errors: [] }],
  };
}
function spec(title = 'discount', tests = [passed()]): any {
  return { file, title, ok: true, tests };
}
function report(specs = [spec()]): any {
  return { config: { rootDir: '/repo' }, errors: [], suites: [{ file, specs }] };
}
const inspect = (input: unknown, files = [file]) => inspectPlaywrightReport(input, files, '/repo');

test('discovers all passing generated specs and all project variants through nested suites', () => {
  const input = report([]);
  input.suites[0].suites = [
    {
      file,
      specs: [spec('coupon', [passed('chromium'), passed('firefox')])],
      suites: [{ file, specs: [spec('shipping')] }],
    },
  ];
  assert.deepEqual(inspect(input), [`${file}: coupon`, `${file}: shipping`]);
  input.config.rootDir = '/repo/tests';
  input.suites[0].file = 'generated/cart.spec.ts';
  input.suites[0].suites[0].file = 'generated/cart.spec.ts';
  input.suites[0].suites[0].specs[0].file = 'generated/cart.spec.ts';
  input.suites[0].suites[0].suites[0].file = 'generated/cart.spec.ts';
  input.suites[0].suites[0].suites[0].specs[0].file = 'generated/cart.spec.ts';
  assert.equal(inspect(input).length, 2);
  input.config.rootDir = 'tests';
  assert.equal(inspect(input).length, 2);
});

const badTests: [string, () => any][] = [
  ['skipped', () => ({ ...passed(), status: 'skipped', results: [{ status: 'skipped' }] })],
  [
    'expected failure',
    () => ({ ...passed(), expectedStatus: 'failed', results: [{ status: 'failed' }] }),
  ],
  ['unexpected pass', () => ({ ...passed(), expectedStatus: 'failed', status: 'unexpected' })],
  ['interrupted', () => ({ ...passed(), results: [{ status: 'interrupted' }] })],
  ['timed out', () => ({ ...passed(), results: [{ status: 'timedOut' }] })],
  ['failed', () => ({ ...passed(), status: 'unexpected', results: [{ status: 'failed' }] })],
  ['flaky', () => ({ ...passed(), status: 'flaky' })],
  [
    'retry after failure',
    () => ({
      ...passed(),
      results: [
        { status: 'failed', retry: 0 },
        { status: 'passed', retry: 1 },
      ],
    }),
  ],
  [
    'two passing attempts',
    () => ({
      ...passed(),
      results: [
        { status: 'passed', retry: 0 },
        { status: 'passed', retry: 1 },
      ],
    }),
  ],
  ['only retry reported', () => ({ ...passed(), results: [{ status: 'passed', retry: 1 }] })],
  ['empty results', () => ({ ...passed(), results: [] })],
  ['missing results', () => ({ expectedStatus: 'passed', status: 'expected' })],
  ['null attempt', () => ({ ...passed(), results: [null] })],
  [
    'result error with passing status',
    () => ({
      ...passed(),
      results: [{ status: 'passed', error: { message: 'afterEach failed' } }],
    }),
  ],
  [
    'result errors with passing status',
    () => ({
      ...passed(),
      results: [{ status: 'passed', errors: [{ message: 'worker failed' }] }],
    }),
  ],
  [
    'test errors with passing status',
    () => ({ ...passed(), errors: [{ message: 'cleanup failed' }] }),
  ],
  [
    'step error with passing status',
    () => ({
      ...passed(),
      results: [{ status: 'passed', steps: [{ title: 'step', error: { message: 'failed' } }] }],
    }),
  ],
];

test('a passing spec never hides a skipped, expected-failure, failed or incomplete sibling in the same file', () => {
  for (const [label, makeBad] of badTests) {
    assert.throws(() => inspect(report([spec('passes'), spec(label, [makeBad()])])), label);
    assert.throws(() => inspect(report([spec(label, [makeBad()]), spec('passes')])), label);
  }
});

test('each discovered browser project must pass once, including projects in separate file suites', () => {
  for (const [label, makeBad] of badTests) {
    const bad = { ...makeBad(), projectName: 'firefox' };
    assert.throws(() => inspect(report([spec('coupon', [passed(), bad])])), label);
    const input = report();
    input.suites.push({ file, specs: [spec('coupon', [bad])] });
    assert.throws(() => inspect(input), label);
  }
});

test('empty generated files and empty test arrays are rejected even beside passing evidence', () => {
  assert.throws(() => inspect(report([])), /empty generated file/);
  assert.throws(() => inspect(report([spec('empty', [])])), /empty/);
  assert.throws(() => inspect(report([spec('passes'), spec('empty', [])])), /empty/);
  const emptyVariant = report();
  emptyVariant.suites.push({ file, specs: [], suites: [] });
  assert.throws(() => inspect(emptyVariant), /empty generated file/);
  const nestedEmpty = report();
  nestedEmpty.suites[0].suites = [{ file, specs: [] }];
  assert.throws(() => inspect(nestedEmpty), /empty generated file/);
  assert.throws(() => inspect(report(), [file, 'tests/generated/missing.spec.ts']), /missing/);
  const missingTests = report();
  delete missingTests.suites[0].specs[0].tests;
  assert.throws(() => inspect(missingTests), /Malformed/);
});

test('report-level and unrelated-test errors or interruptions override otherwise passing generated tests', () => {
  for (const errors of [
    [{ message: 'global teardown failed' }],
    { message: 'malformed errors' },
    null,
  ]) {
    const input = report();
    input.errors = errors;
    assert.throws(() => inspect(input), /errors/);
  }
  for (const status of ['interrupted', 'failed', 'timedout']) {
    const input = report();
    input.status = status;
    assert.throws(() => inspect(input));
  }
  for (const result of [
    { status: 'interrupted' },
    { status: 'passed', errors: [{ message: 'background failure' }] },
  ]) {
    const input = report();
    input.suites.push({
      file: 'tests/other.spec.ts',
      specs: [
        {
          ...spec('other'),
          file: 'tests/other.spec.ts',
          tests: [{ ...passed(), results: [result] }],
        },
      ],
    });
    assert.throws(() => inspect(input));
  }
  const unrelatedSkip = report();
  unrelatedSkip.suites.push({
    file: 'tests/other.spec.ts',
    specs: [
      {
        ...spec('other'),
        file: 'tests/other.spec.ts',
        tests: [{ ...passed(), status: 'skipped', results: [{ status: 'skipped' }] }],
      },
    ],
  });
  assert.equal(inspect(unrelatedSkip).length, 1);
});

test('invalid tree shapes and explicitly failed spec summaries are not silently discarded', () => {
  for (const input of [null, [], {}, { suites: {} }, { suites: [null] }, { specs: {} }])
    assert.throws(() => inspect(input));
  const failed = report();
  failed.suites[0].specs[0].ok = false;
  assert.throws(() => inspect(failed));
  const missingFile = report();
  delete missingFile.suites[0].specs[0].file;
  assert.throws(() => inspect(missingFile));
  const sparse = report();
  sparse.suites[0].specs[0].tests = Array(1);
  assert.throws(() => inspect(sparse));
  const cyclic = report();
  cyclic.suites.push(cyclic);
  assert.throws(() => inspect(cyclic), /Cyclic/);
});

test('verification command accepts 100 generated files and at most 256 arguments', () => {
  const batch = {
    executable: 'npx',
    label: 'Generated tests',
    args: [
      '--no-install',
      'playwright',
      'test',
      ...Array.from({ length: 100 }, (_, index) => `tests/generated/${index}.spec.ts`),
      '--reporter=list,json',
      '--retries=0',
    ],
  };
  assert.doesNotThrow(() => validateCommand(batch));
  assert.doesNotThrow(() => validateCommand({ ...batch, args: Array(256).fill('arg') }));
  assert.throws(() => validateCommand({ ...batch, args: Array(257).fill('arg') }));
  assert.throws(() => validateCommand({ ...batch, args: ['nul\0byte'] }));
  assert.throws(() => validateCommand({ ...batch, args: ['a'.repeat(4001)] }));
  assert.throws(() => validateCommand({ ...batch, args: Array(1) }));
});

test('exit zero cannot turn mixed results, report errors, or interrupted execution into verification success', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.journeyproof'));
  const cases: [string, any][] = [
    ['mixed skipped spec', report([spec('passes'), spec('skips', [badTests[0][1]()])])],
    [
      'mixed expected-failure spec',
      report([spec('passes'), spec('expected failure', [badTests[1][1]()])]),
    ],
    ['report errors', { ...report(), errors: [{ message: 'global teardown failed' }] }],
    ['interruption', { ...report(), status: 'interrupted' }],
    ['empty test array', report([spec('passes'), spec('empty', [])])],
  ];
  for (const [label, input] of cases) {
    input.config.rootDir = await realpath(root);
    const command = {
      executable: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, process.argv[1]);",
        JSON.stringify(input),
      ],
      label,
    };
    const result = await verifyWorkspace(root, command, 3, { expectedPlaywrightFiles: [file] });
    assert.equal(result.status, 'failed', label);
    assert.equal(result.runs.length, 1, label);
    assert.equal(result.runs[0].exitCode, 0, label);
    assert.equal(result.discoveredTests, undefined, label);
    assert.match(result.runs[0].output, /could not confirm generated test execution/);
    assert.equal(
      JSON.parse(await readFile(path.join(root, '.journeyproof/verification.json'), 'utf8')).status,
      'failed',
    );
  }
  const passing = report([spec('coupon', [passed(), passed('firefox')]), spec('shipping')]);
  passing.config.rootDir = await realpath(root);
  const command = {
    executable: process.execPath,
    args: [
      '-e',
      "require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, process.argv[1]);",
      JSON.stringify(passing),
    ],
    label: 'passes',
  };
  const result = await verifyWorkspace(root, command, 2, { expectedPlaywrightFiles: [file] });
  assert.equal(result.status, 'passed');
  assert.equal(result.runs.length, 2);
  assert.equal(result.discoveredTests?.length, 2);
});
