import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AGENT_SETTINGS,
  BoundedNdjson,
  agentPrompt,
  detectAgents,
  generateWithAgent,
  runAgentProcess,
  validateAgentSettings,
} from '../src/core/agents';
import { claudeArguments, parseClaudeResult } from '../src/core/claude';
import { codexGenerate, generationPrompt, GENERATION_SCHEMA } from '../src/core/codex';
import type { AgentSettings, Project, Scenario } from '../src/shared/types';

const project: Project = {
  id: 'p',
  name: 'Synthetic cart',
  path: '/private/connected-project',
  framework: 'playwright-ts',
  buildTool: 'npm',
  summary: '',
  examples: [],
  commands: [],
  outputDir: 'tests/testloom/case-one',
};
const scenario: Scenario = {
  schemaVersion: 1,
  id: 'case-one',
  name: 'Discount applies',
  startUrl: 'http://127.0.0.1:4333/',
  createdAt: '2026-09-07T00:00:00Z',
  warnings: [],
  network: [],
  events: [
    {
      id: 'e1',
      sequence: 1,
      timestamp: '',
      action: 'navigate',
      url: 'http://127.0.0.1:4333/',
      pageId: 'page-1',
      label: 'Navigate',
      locators: [],
    },
  ],
  assertions: [
    {
      id: 'req-total',
      description: 'The total is $90.00',
      kind: 'text',
      locator: { strategy: 'testId', value: 'total' },
      expected: '$90.00',
      source: 'user',
    },
  ],
};
const payload = {
  summary: 'Generated a synthetic test.',
  warnings: [],
  files: [
    {
      path: `${project.outputDir}/cart.spec.ts`,
      content:
        "// Requirement req-total\nawait expect(page.getByTestId('total')).toHaveText('$90.00');\n",
    },
  ],
};
const terminal = (structured_output: unknown = payload) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output,
});
const setting = (extra: Partial<AgentSettings> = {}) =>
  validateAgentSettings({ provider: 'claude', ...extra });

async function fixture(t: TestContext, claudeBody: string, codexBody = claudeBody) {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-agents-test-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const config = path.join(root, 'config');
  await mkdir(config);
  const originals = new Map(
    ['PATH', 'CLAUDE_CONFIG_DIR', 'TESTLOOM_CAPTURE', 'TESTLOOM_SYNTHETIC_AUTH'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  t.after(async () => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const [name, body] of [
    ['claude', claudeBody],
    ['codex', codexBody],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${body}\n`);
    await chmod(file, 0o700);
  }
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.TESTLOOM_CAPTURE = path.join(root, 'capture.json');
  process.env.TESTLOOM_SYNTHETIC_AUTH = 'synthetic-auth-retained';
  return { root, config, capture: process.env.TESTLOOM_CAPTURE };
}

const captureStdin = `
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
fs.writeFileSync(process.env.TESTLOOM_CAPTURE, JSON.stringify({ args, input, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR, auth: process.env.TESTLOOM_SYNTHETIC_AUTH, updates: process.env.DISABLE_AUTOUPDATER }));
`;

test('settings normalize defaults without sharing mutable arrays and enforce boundaries', () => {
  const a = validateAgentSettings({});
  a.excludedContextPaths.push('private');
  assert.deepEqual(DEFAULT_AGENT_SETTINGS.excludedContextPaths, []);
  assert.deepEqual(validateAgentSettings({}).excludedContextPaths, []);
  assert.equal(setting({ model: ' haiku ' }).model, 'haiku');
  assert.equal(setting({ model: 'claude-sonnet-4-6[1m]' }).model, 'claude-sonnet-4-6[1m]');
  assert.deepEqual(
    setting({ excludedContextPaths: ['./tests/private/', 'tests\\private', '**/*.secret.ts'] })
      .excludedContextPaths,
    ['tests/private', '**/*.secret.ts'],
  );
  for (const input of [
    null,
    [],
    'claude',
    { provider: 'other' },
    { effort: 'max' },
    { model: '--dangerously-skip-permissions' },
    { model: 'haiku;echo x' },
    { model: 'x'.repeat(161) },
    { model: 4 },
    { timeoutSeconds: 29 },
    { timeoutSeconds: 1801 },
    { timeoutSeconds: 30.1 },
    { timeoutSeconds: NaN },
    { timeoutSeconds: '60' },
    { instructions: 'x'.repeat(8001) },
    { instructions: '\0' },
    { excludedContextPaths: ['../secret'] },
    { excludedContextPaths: ['/secret'] },
    { excludedContextPaths: ['C:\\secret'] },
    { excludedContextPaths: [5] },
    { excludedContextPaths: Array(101).fill('a') },
    { claudeBudgetUsd: 0 },
    { claudeBudgetUsd: 20.01 },
    { claudeBudgetUsd: Infinity },
    { claudeBudgetUsd: '1' },
  ])
    assert.throws(() => validateAgentSettings(input));
  for (const timeoutSeconds of [30, 1800])
    assert.equal(setting({ timeoutSeconds }).timeoutSeconds, timeoutSeconds);
  for (const claudeBudgetUsd of [0.01, 20])
    assert.equal(setting({ claudeBudgetUsd }).claudeBudgetUsd, claudeBudgetUsd);
  assert.equal('unknown' in validateAgentSettings({ unknown: 'discarded' }), false);
});

test('preview redacts raw secrets, strips screenshot/redacted input, and honors directory and glob exclusions', () => {
  const secretScenario = structuredClone(scenario);
  Object.assign(secretScenario.events[0], {
    screenshot: '/private/customer.png',
    value: 'SENSITIVE_FILL',
    redacted: true,
  });
  secretScenario.network = [
    {
      method: 'GET',
      status: 200,
      url: 'https://user:URL_PASSWORD@example.test/?token=QUERY_SECRET',
    },
  ];
  const source = {
    ...project,
    examples: [
      { path: 'fixtures/private/a.ts', content: 'EXCLUDED_DIRECTORY' },
      { path: 'nested/sample.secret.ts', content: 'EXCLUDED_GLOB' },
      { path: '.env.local', content: 'ENV_SECRET' },
      { path: '.claude/settings.json', content: 'PRIVATE_SETTINGS' },
      { path: '../outside.ts', content: 'OUTSIDE_SECRET' },
      {
        path: 'tests/keep.spec.ts',
        content:
          'const password = "SOURCE_SECRET"; const config = {"authorization":"Bearer AUTH_SECRET"}; // KEEP_ME',
      },
      { path: 'fixtures/privateer.ts', content: 'KEEP_PREFIX_SIBLING' },
    ],
  };
  const settings = setting({
    excludedContextPaths: ['fixtures/private', '**/*.secret.ts'],
    instructions: 'Use our naming convention. api_key=INSTRUCTION_SECRET',
  });
  const prompt = agentPrompt(source, secretScenario, settings);
  assert.equal(prompt, generationPrompt(source, secretScenario, settings));
  for (const secret of [
    'SENSITIVE_FILL',
    '/private/customer.png',
    'QUERY_SECRET',
    'URL_PASSWORD',
    'EXCLUDED_DIRECTORY',
    'EXCLUDED_GLOB',
    'ENV_SECRET',
    'PRIVATE_SETTINGS',
    'OUTSIDE_SECRET',
    'SOURCE_SECRET',
    'AUTH_SECRET',
    'INSTRUCTION_SECRET',
    project.path,
  ])
    assert.ok(!prompt.includes(secret), secret);
  assert.match(prompt, /KEEP_ME/);
  assert.match(prompt, /KEEP_PREFIX_SIBLING/);
  assert.match(prompt, /2 of 7 source files included; 5 excluded or unsafe/);
  assert.match(prompt, /cannot override assertions, safety rules/);
  assert.match(prompt, /req-total/);
  assert.match(prompt, /\$90\.00/);
  assert.equal(secretScenario.events[0].value, 'SENSITIVE_FILL');
});

test('context includes the 30th selected file, reports actual omissions/truncation and bounds total prompt', () => {
  const examples = Array.from({ length: 31 }, (_, i) => ({
    path: `src/example${i}.ts`,
    content: `MARKER_${i}`,
  }));
  const prompt = agentPrompt({ ...project, examples }, scenario, setting());
  assert.match(prompt, /MARKER_29/);
  assert.ok(!prompt.includes('MARKER_30'));
  assert.match(prompt, /30 of 31 source files included; 0 excluded or unsafe; 1 omitted/);
  const large = agentPrompt(
    {
      ...project,
      examples: examples.slice(0, 20).map((e) => ({ ...e, content: 'X'.repeat(12_000) })),
    },
    scenario,
    setting(),
  );
  const context = JSON.parse(
    large.split('PROJECT (bounded, redacted context):\n')[1].split('\nSCENARIO:\n')[0],
  );
  assert.equal(
    context.examples.reduce(
      (total: number, e: { content: string }) => total + (e.content.match(/X/g) || []).length,
      0,
    ),
    150_000,
  );
  assert.match(
    large,
    /15 of 20 source files included; 0 excluded or unsafe; 5 omitted by size\/count limits; 15 included files truncated/,
  );
  assert.ok(Buffer.byteLength(large) < 300_000);
  assert.throws(
    () => agentPrompt(project, { ...scenario, name: 'X'.repeat(300_000) }, setting()),
    /too large/,
  );
});

test('Claude flags enforce no tools, strict empty MCP, noninteractive operation, effort and budget without bypass or bare', () => {
  const args = claudeArguments(setting({ model: 'haiku', effort: 'high', claudeBudgetUsd: 0.25 }), {
    disableAllHooks: true,
  });
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  for (const flag of [
    '--print',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
  ])
    assert.ok(args.includes(flag));
  assert.equal(get('--tools'), '');
  assert.equal(get('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(get('--permission-mode'), 'dontAsk');
  assert.equal(get('--setting-sources'), 'user');
  assert.equal(get('--effort'), 'high');
  assert.equal(get('--max-budget-usd'), '0.25');
  assert.equal(get('--model'), 'haiku');
  assert.deepEqual(JSON.parse(get('--json-schema')), GENERATION_SCHEMA);
  assert.ok(!args.some((arg) => /dangerously|bypassPermissions|^--bare$|--chrome$/.test(arg)));
});

test('Claude accepts only successful structured_output and rejects errors, invalid files and malformed schema', () => {
  assert.deepEqual(parseClaudeResult(terminal(), project).files, payload.files);
  const errors = [
    null,
    [],
    {},
    { ...terminal(), type: 'assistant' },
    { ...terminal(), is_error: true, result: 'PRIVATE_ERROR' },
    { ...terminal(), is_error: undefined },
    { ...terminal(), subtype: 'error_during_execution' },
    { ...terminal(), structured_output: undefined, result: JSON.stringify(payload) },
    { ...terminal(), structured_output: JSON.stringify(payload) },
    { ...terminal(), permission_denials: [{ tool_name: 'Bash', tool_input: 'PRIVATE_INPUT' }] },
    terminal({ ...payload, summary: 7 }),
    terminal({ ...payload, warnings: [5] }),
    terminal({ ...payload, files: [{ path: '../secret.ts', content: 'x' }] }),
    terminal({ ...payload, files: [{ path: 'tests/testloom/case-other/a.ts', content: 'x' }] }),
    terminal({ ...payload, files: Array(13).fill(payload.files[0]) }),
    terminal({ ...payload, files: [] }),
  ];
  for (const value of errors)
    assert.throws(
      () => parseClaudeResult(value, project),
      (error) => error instanceof Error && !/PRIVATE_ERROR|PRIVATE_INPUT/.test(error.message),
    );
  assert.throws(
    () =>
      parseClaudeResult(
        { ...terminal(), subtype: 'error_max_budget_usd', is_error: true },
        project,
      ),
    /budget/,
  );
  assert.throws(
    () => parseClaudeResult({ ...terminal(), subtype: 'error_max_turns', is_error: true }, project),
    /turn limit/,
  );
});

test('NDJSON handles split UTF-8, CRLF and final unterminated record and fails closed on bounds/malformed JSON', () => {
  const values: unknown[] = [];
  const parser = new BoundedNdjson((value) => values.push(value));
  const bytes = Buffer.from('{"text":"💡₹"}\r\n\n{"last":true}');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.finish();
  assert.deepEqual(values, [{ text: '💡₹' }, { last: true }]);
  assert.throws(
    () => new BoundedNdjson(() => {}, 20).push(Buffer.from('x'.repeat(21))),
    /record size/,
  );
  assert.throws(
    () => new BoundedNdjson(() => {}, 20, 30).push(Buffer.from('{}\n'.repeat(11))),
    /generation size/,
  );
  assert.throws(
    () => new BoundedNdjson(() => {}).push(Buffer.from('PRIVATE_RAW_LOG\n')),
    (error) => error instanceof Error && !error.message.includes('PRIVATE_RAW_LOG'),
  );
  const truncated = new BoundedNdjson(() => {});
  truncated.push(Buffer.from('{"incomplete":'));
  assert.throws(() => truncated.finish(), /malformed/);
});

test('Claude integration uses exact preview stdin, keeps auth, suppresses plugins/hooks and ignores interleaved stderr', async (t) => {
  const body =
    captureStdin +
    `
process.stderr.write('PRIVATE_STDERR not JSON\\n' + JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true}) + '\\n');
process.stdout.write(JSON.stringify({type:'system',subtype:'init'})+'\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(terminal()))});
});`;
  const f = await fixture(t, body);
  const original = JSON.stringify({
    apiKeyHelper: 'existing-auth-helper',
    env: { ANTHROPIC_BASE_URL: 'https://synthetic-auth.example' },
    hooks: { SessionStart: ['PRIVATE_HOOK'] },
    enabledPlugins: { 'synthetic@local': true },
  });
  await writeFile(path.join(f.config, 'settings.json'), original);
  const progress: string[] = [];
  const settings = setting({ effort: 'low', timeoutSeconds: 60, instructions: 'Use clear names.' });
  const result = await generateWithAgent(project, scenario, f.root, settings, {
    onProgress: (message) => progress.push(message),
  });
  assert.deepEqual(result.files, payload.files);
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(captured.input, agentPrompt(project, scenario, settings));
  assert.notEqual(captured.cwd, project.path);
  assert.notEqual(captured.cwd, f.root);
  const overrides = JSON.parse(captured.args[captured.args.indexOf('--settings') + 1]);
  assert.equal(overrides.disableAllHooks, true);
  assert.equal(overrides.autoMemoryEnabled, false);
  assert.deepEqual(overrides.enabledPlugins, { 'synthetic@local': false });
  assert.equal(overrides.apiKeyHelper, undefined);
  assert.equal(overrides.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(captured.auth, 'synthetic-auth-retained');
  assert.equal(captured.configDir, f.config);
  assert.equal(captured.updates, '1');
  assert.equal(await readFile(path.join(f.config, 'settings.json'), 'utf8'), original);
  assert.equal(progress.length, 2);
  assert.ok(!progress.join().includes('PRIVATE'));
  await assert.rejects(access(captured.cwd));
});

test('large Claude terminal records survive the merged process diagnostic tail limit', async (t) => {
  const big = {
    ...payload,
    files: [0, 1, 2].map((i) => ({
      path: `${project.outputDir}/${i}.spec.ts`,
      content: '// 💡\n' + 'a'.repeat(100_000),
    })),
  };
  const body =
    captureStdin + `process.stdout.write(JSON.stringify(${JSON.stringify(terminal(big))})); });`;
  const f = await fixture(t, body);
  const result = await generateWithAgent(project, scenario, f.root, setting());
  assert.equal(result.files.length, 3);
  assert.equal(result.files[2].content, big.files[2].content);
});

test('Claude rejects stdout errors, duplicate/missing terminals, nonzero exit and invalid local settings without raw log exposure', async (t) => {
  for (const [name, output, code, pattern] of [
    [
      'duplicate',
      JSON.stringify(terminal()) + '\n' + JSON.stringify(terminal()) + '\n',
      0,
      /after its terminal/,
    ],
    ['missing', '{"type":"assistant","message":"PRIVATE_MESSAGE"}\n', 0, /no terminal/],
    ['invalid', '{"type":"result"', 0, /malformed/],
    ['exit', JSON.stringify(terminal()) + '\n', 2, /could not complete/],
    [
      'budget',
      JSON.stringify({ ...terminal(), subtype: 'error_max_budget_usd', is_error: true }) + '\n',
      1,
      /budget/,
    ],
    [
      'authentication',
      '{"type":"system","subtype":"api_retry","error_status":401,"error":"PRIVATE_AUTH_LOG"}\n' +
        JSON.stringify({ ...terminal(), subtype: 'error_during_execution', is_error: true }) +
        '\n',
      1,
      /HTTP 401/,
    ],
  ] as const)
    await t.test(name, async (sub) => {
      const f = await fixture(
        sub,
        captureStdin +
          `process.stdout.write(${JSON.stringify(output)}); process.stderr.write('PRIVATE_DIAGNOSTIC'); process.exitCode=${code}; });`,
      );
      await assert.rejects(
        generateWithAgent(project, scenario, f.root, setting()),
        (error) =>
          error instanceof Error &&
          pattern.test(error.message) &&
          !error.message.includes('PRIVATE'),
      );
    });
  await t.test('settings', async (sub) => {
    const f = await fixture(sub, 'throw new Error("must not launch");');
    await writeFile(path.join(f.config, 'settings.json'), 'PRIVATE_BROKEN_SETTINGS');
    await assert.rejects(
      generateWithAgent(project, scenario, f.root, setting()),
      /settings could not be safely loaded/,
    );
    await assert.rejects(access(f.capture));
  });
});

test('Codex retains legacy API, uses per-run settings/exact prompt and never reuses stale or other-case responses', async (t) => {
  const body =
    captureStdin +
    `
const response = args[args.indexOf('--output-last-message') + 1];
if (fs.existsSync(response)) throw new Error('stale response exists');
if (input.includes('MALFORMED_CASE')) fs.writeFileSync(response, '{broken');
else if (!input.includes('MISSING_CASE')) fs.writeFileSync(response, ${JSON.stringify(JSON.stringify(payload))});
process.stdout.write('{"type":"turn.started"}\\n');
process.stderr.write('PRIVATE_CODEX_LOG');
});`;
  const f = await fixture(t, body);
  const settings = validateAgentSettings({
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    timeoutSeconds: 60,
    instructions: 'Follow our fixture conventions.',
  });
  const result = await codexGenerate(project, scenario, f.root, settings);
  assert.deepEqual(result.files, payload.files);
  const first = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(first.input, agentPrompt(project, scenario, settings));
  assert.ok(first.args.includes('model_reasoning_effort="high"'));
  assert.ok(first.args.includes('approval_policy="never"'));
  assert.equal(first.args[first.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'gpt-5.4');
  await assert.rejects(
    generateWithAgent(project, { ...scenario, name: 'MALFORMED_CASE' }, f.root, settings),
    /no valid structured result/,
  );
  const second = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.notEqual(second.cwd, first.cwd);
  await assert.rejects(access(first.cwd));
  await assert.rejects(access(second.cwd));
  await assert.rejects(
    generateWithAgent(project, { ...scenario, name: 'MISSING_CASE' }, f.root, settings),
    /no valid structured result/,
  );
  await assert.rejects(
    generateWithAgent(
      { ...project, outputDir: 'tests/testloom/case-two' },
      scenario,
      f.root,
      settings,
    ),
    /invalid test files/,
  );
});

test('detection exposes only sanitized versions and portable dispatch never launches an agent', async (t) => {
  await fixture(
    t,
    "process.stdout.write('2.1.116 (Claude Code)\\n'); process.stderr.write('PRIVATE_VERSION_LOG');",
    "process.stdout.write('codex-cli 0.120.0\\n'); process.stderr.write('PRIVATE_VERSION_LOG');",
  );
  const detected = await detectAgents();
  assert.equal(detected.claude.available, true);
  assert.equal(detected.claude.version, '2.1.116 (Claude Code)');
  assert.equal(detected.codex.available, true);
  assert.equal(detected.codex.version, 'codex-cli 0.120.0');
  const result = await generateWithAgent(
    project,
    scenario,
    '/unused',
    setting({ provider: 'portable', instructions: 'Use custom fixture.' }),
  );
  assert.match(result.files[0].content, /req-total/);
  assert.match(result.warnings.join(), /does not interpret custom instructions/);
  for (const provider of ['portable', 'claude', 'codex'] as const) {
    await assert.rejects(
      generateWithAgent(project, { ...scenario, events: [] }, '/unused', setting({ provider })),
      /Record a journey/,
    );
    await assert.rejects(
      generateWithAgent(project, { ...scenario, assertions: [] }, '/unused', setting({ provider })),
      /expected result/,
    );
  }
});

test('cancellation before launch is respected for all providers', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const provider of ['codex', 'claude', 'portable'] as const)
    await assert.rejects(
      generateWithAgent(project, scenario, '/unused', setting({ provider }), {
        signal: controller.signal,
      }),
      /cancelled/,
    );
});

test('Claude cancellation stops the process group and does not expose partial output', async (t) => {
  const f = await fixture(
    t,
    captureStdin +
      `process.stdout.write('{"type":"system","subtype":"init"}\\n'); setInterval(() => {}, 1000); });`,
  );
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(
    generateWithAgent(project, scenario, f.root, setting(), {
      signal: controller.signal,
      onProgress: (message) => {
        if (message.includes('started reasoning')) controller.abort();
      },
    }),
    /cancelled/,
  );
  assert.ok(Date.now() - start < 6000);
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  await assert.rejects(access(captured.cwd));
});

test('provider relay enforces process timeout and aborts oversized unterminated stdout', async () => {
  const timed = await runAgentProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: tmpdir(),
    timeoutMs: 60,
    onEvent: () => {},
  });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.code, 0);
  await assert.rejects(
    runAgentProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(8_100_000)); setInterval(() => {}, 1000)'],
      { cwd: tmpdir(), timeoutMs: 10_000, onEvent: () => {} },
    ),
    /record size/,
  );
});
