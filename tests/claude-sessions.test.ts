import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeArguments, claudeGenerate } from '../src/core/claude';
import { validateAgentSettings } from '../src/core/agents';
import type { Project, Scenario } from '../src/shared/types';

const project: Project = {
  id: 'project',
  name: 'Cart',
  path: '/connected/original',
  framework: 'playwright-ts',
  buildTool: 'npm',
  summary: '',
  examples: [],
  commands: [],
  outputDir: 'tests/testloom/case',
};
const scenario: Scenario = {
  schemaVersion: 1,
  id: 'case-a',
  name: 'Cart total',
  startUrl: 'http://localhost:3000',
  createdAt: '2026-09-08T00:00:00Z',
  warnings: [],
  network: [],
  events: [
    {
      id: 'event-1',
      sequence: 1,
      timestamp: '',
      action: 'navigate',
      url: 'http://localhost:3000',
      pageId: 'page-1',
      label: 'Open cart',
      locators: [],
    },
  ],
  assertions: [
    {
      id: 'requirement-1',
      description: 'Cart total is $90',
      kind: 'text',
      locator: { strategy: 'testId', value: 'total' },
      expected: '$90',
      source: 'user',
    },
  ],
};
const output = {
  summary: 'Generated cart test.',
  warnings: [],
  files: [
    {
      path: `${project.outputDir}/cart.spec.ts`,
      content: "// requirement-1\nawait expect(page.getByTestId('total')).toHaveText('$90');\n",
    },
  ],
};
const settings = (extra = {}) => validateAgentSettings({ provider: 'claude', ...extra });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'testloom-claude-sessions-'));
  const snapshot = path.join(root, 'snapshot'),
    bin = path.join(root, 'bin'),
    config = path.join(root, 'config');
  for (const dir of [snapshot, bin, config]) await mkdir(dir);
  await writeFile(path.join(snapshot, 'source.ts'), 'export const original = true;\n');
  const saved = new Map(
    [
      'PATH',
      'CLAUDE_CONFIG_DIR',
      'TESTLOOM_SESSION_CAPTURE',
      'TESTLOOM_SESSION_MODE',
      'TESTLOOM_SESSION_AUTH',
      'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
    ].map((key) => [key, process.env[key]]),
  );
  t.after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.TESTLOOM_SESSION_CAPTURE = path.join(root, 'capture.jsonl');
  process.env.TESTLOOM_SESSION_AUTH = 'synthetic-auth';
  process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  delete process.env.TESTLOOM_SESSION_MODE;
  await writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'local@test': true }, apiKeyHelper: 'synthetic-helper' }),
  );
  const cli = path.join(bin, 'claude');
  await writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), get = key => args[args.indexOf(key)+1];
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  const id = args.includes('--resume') ? get('--resume') : get('--session-id');
  const nativeFile = path.join(process.cwd(), 'native-' + id + '.json');
  const previous = args.includes('--resume') ? JSON.parse(fs.readFileSync(nativeFile, 'utf8')) : [];
  previous.push(input); fs.writeFileSync(nativeFile, JSON.stringify(previous));
  const configPath = get('--mcp-config');
  fs.appendFileSync(process.env.TESTLOOM_SESSION_CAPTURE, JSON.stringify({ args, cwd: process.cwd(), input,
    config: JSON.parse(fs.readFileSync(configPath, 'utf8')), turns: previous.length,
    auth: process.env.TESTLOOM_SESSION_AUTH, configDir: process.env.CLAUDE_CONFIG_DIR,
    persist: process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY }) + '\\n');
  const mode = process.env.TESTLOOM_SESSION_MODE;
  if (mode === 'oversized') { process.stdout.write('x'.repeat(8000001)); return; }
  const initId = mode === 'mismatch' ? '550e8400-e29b-41d4-a716-446655440000' : mode === 'invalid' ? '../other' : id;
  if (mode !== 'no-init') process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:initId})+'\\n');
  if (mode === 'wait') { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({type:'result',subtype:mode === 'failure' ? 'error_max_budget_usd' : 'success',
    is_error:mode === 'failure', session_id:id, structured_output:${JSON.stringify(output)}})+'\\n');
});\n`,
    { mode: 0o700 },
  );
  await chmod(cli, 0o700);
  const records = async () =>
    (await readFile(process.env.TESTLOOM_SESSION_CAPTURE!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { root, snapshot, config, records };
}

test('Claude native sessions resume two turns, preserve auth/transcripts, and isolate different cases', async (t) => {
  const f = await fixture(t),
    cwd = path.join(f.root, 'case-a');
  const ids: string[] = [];
  const first = await claudeGenerate(
    project,
    scenario,
    f.snapshot,
    settings({ excludedContextPaths: ['private/**'] }),
    { session: { cwd }, onSession: (id) => ids.push(id) },
  );
  assert.deepEqual(first.files, output.files);
  assert.equal(ids.length, 1);
  const snapshot2 = path.join(f.root, 'snapshot-2');
  await mkdir(snapshot2);
  await writeFile(path.join(snapshot2, 'source.ts'), 'export const current = true;');
  await claudeGenerate(
    project,
    { ...scenario, name: 'Updated cart total' },
    snapshot2,
    settings(),
    { session: { cwd, id: ids[0] }, onSession: (id) => ids.push(id) },
  );
  const other: string[] = [];
  await claudeGenerate(project, { ...scenario, id: 'case-b' }, f.snapshot, settings(), {
    session: { cwd: path.join(f.root, 'case-b') },
    onSession: (id) => other.push(id),
  });
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], other[0]);
  const records = await f.records();
  assert.deepEqual(
    records.map((r) => r.turns),
    [1, 2, 1],
  );
  const arg = (n: number, flag: string) => records[n].args[records[n].args.indexOf(flag) + 1];
  assert.equal(arg(0, '--session-id'), ids[0]);
  assert.equal(arg(1, '--resume'), ids[0]);
  assert.ok(!records[0].args.includes('--resume'));
  assert.ok(!records[1].args.includes('--session-id'));
  assert.ok(
    records.every(
      (r) => !r.args.includes('--no-session-persistence') && !r.args.includes('--bare'),
    ),
  );
  assert.equal(records[0].cwd, cwd);
  assert.equal(records[1].cwd, cwd);
  assert.equal(arg(0, '--tools'), '');
  assert.equal(arg(0, '--permission-mode'), 'dontAsk');
  assert.ok(records[0].args.includes('--strict-mcp-config'));
  assert.equal(arg(0, '--effort'), 'max');
  assert.equal(arg(0, '--name'), 'Testloom: Cart total');
  assert.equal(arg(1, '--name'), 'Testloom: Updated cart total');
  assert.equal(Object.keys(records[0].config.mcpServers).join(), 'repository');
  const server = records[0].config.mcpServers.repository;
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /dist\/main\/repository-mcp\.cjs$/);
  assert.deepEqual(server.args.slice(1), [f.snapshot, '["private/**"]']);
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(records[1].config.mcpServers.repository.args[1], snapshot2);
  assert.ok(arg(0, '--allowedTools').includes('mcp__repository__repository_read'));
  assert.ok(
    records.every(
      (r) => r.auth === 'synthetic-auth' && r.configDir === f.config && r.persist === '0',
    ),
  );
  assert.equal((await stat(path.join(cwd, 'repository-mcp.json'))).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(path.join(cwd, `native-${ids[0]}.json`), 'utf8')).length,
    2,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(f.config, 'settings.json'), 'utf8')).apiKeyHelper,
    'synthetic-helper',
  );
  assert.equal(
    await readFile(path.join(f.snapshot, 'source.ts'), 'utf8'),
    'export const original = true;\n',
  );
});

test('unknown resume IDs, case/cwd reuse and incorrect init IDs fail closed', async (t) => {
  const f = await fixture(t),
    cwd = path.join(f.root, 'case-a');
  let id = '';
  await claudeGenerate(project, scenario, f.snapshot, settings(), {
    session: { cwd },
    onSession: (value) => (id = value),
  });
  await assert.rejects(
    claudeGenerate(project, { ...scenario, id: 'case-b' }, f.snapshot, settings(), {
      session: { cwd, id },
    }),
    /different/,
  );
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), {
      session: { cwd, id: randomUUID() },
    }),
    /does not belong/,
  );
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), {
      session: { cwd: path.join(f.root, 'other'), id },
    }),
    /does not belong/,
  );
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), { session: { cwd, id: '../other' } }),
    /UUID/,
  );
  for (const mode of ['mismatch', 'invalid', 'no-init']) {
    process.env.TESTLOOM_SESSION_MODE = mode;
    const emitted: string[] = [];
    await assert.rejects(
      claudeGenerate(project, scenario, f.snapshot, settings(), {
        session: { cwd, id },
        onSession: (value) => emitted.push(value),
      }),
      /session/,
    );
    assert.deepEqual(emitted, []);
  }
});

test('Claude session names remove controls and are capped at 180 characters', () => {
  const args = claudeArguments(
    settings(),
    {},
    {
      session: { id: randomUUID(), resume: false },
      name: `Testloom: Cart\n\x00\x1b\x85\t${'x'.repeat(250)}`,
    },
  );
  const name = args[args.indexOf('--name') + 1];
  assert.equal(name.length, 180);
  assert.match(name, /^Testloom: Cart /);
  assert.doesNotMatch(name, /[\x00-\x1f\x7f-\x9f]/);
  assert.ok(!claudeArguments(settings(), {}, { name: 'unused' }).includes('--name'));
});

test('Claude maps extra high and maximum to supported max effort', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const args = claudeArguments(settings({ effort }), {});
    assert.equal(
      args[args.indexOf('--effort') + 1],
      ['xhigh', 'max'].includes(effort) ? 'max' : effort,
    );
  }
});

test('Claude sends ledger and labeled screenshots directly as native multimodal user input', async (t) => {
  const f = await fixture(t),
    cwd = path.join(f.root, 'case-a');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=',
    'base64',
  );
  const imagePath = path.join(f.root, 'recording.png');
  await writeFile(imagePath, png);
  await claudeGenerate(project, scenario, f.snapshot, settings(), {
    session: { cwd },
    evidenceImages: [{ path: imagePath, mimeType: 'image/png', label: 'Screenshot after event-1' }],
  });
  const [record] = await f.records();
  assert.equal(record.args[record.args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(record.input.trim().split('\n').length, 1);
  const message = JSON.parse(record.input);
  assert.equal(message.type, 'user');
  assert.equal(message.message.role, 'user');
  assert.match(message.message.content[0].text, /event-1/);
  assert.match(message.message.content[0].text, /requirement-1/);
  assert.equal(message.message.content[1].text, 'Screenshot after event-1');
  assert.deepEqual(message.message.content[2], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
  });
  assert.doesNotMatch(record.input, new RegExp(imagePath));
});

test('Claude rejects unsafe or oversized image evidence before launching', async (t) => {
  const f = await fixture(t),
    cwd = path.join(f.root, 'case-a');
  const target = path.join(f.root, 'target.png');
  await writeFile(target, 'not a png');
  const linked = path.join(f.root, 'linked.png');
  await symlink(target, linked);
  const huge = path.join(f.root, 'huge.png');
  const fd = await open(huge, 'w');
  await fd.truncate(50 * 1024 * 1024 + 1);
  await fd.close();
  for (const file of [target, linked, huge])
    await assert.rejects(
      claudeGenerate(project, scenario, f.snapshot, settings(), {
        session: { cwd },
        evidenceImages: [{ path: file, mimeType: 'image/png', label: 'Evidence' }],
      }),
      /screenshot/,
    );
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), {
      session: { cwd },
      evidenceImages: Array.from({ length: 101 }, () => ({
        path: target,
        mimeType: 'image/png' as const,
        label: 'Evidence',
      })),
    }),
    /100 screenshots/,
  );
  await assert.rejects(f.records(), /ENOENT/);
});

test('persistent Claude cancellation and oversized NDJSON retain session ownership and stop the process', async (t) => {
  const f = await fixture(t),
    cwd = path.join(f.root, 'case-a');
  process.env.TESTLOOM_SESSION_MODE = 'wait';
  const controller = new AbortController();
  let id = '';
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), {
      session: { cwd },
      signal: controller.signal,
      onSession: (value) => {
        id = value;
        setTimeout(() => controller.abort(), 20);
      },
    }),
    /cancelled/,
  );
  assert.ok(id);
  assert.equal(
    JSON.parse(await readFile(path.join(cwd, 'claude-session.json'), 'utf8')).sessionId,
    id,
  );
  process.env.TESTLOOM_SESSION_MODE = 'oversized';
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), { session: { cwd, id } }),
    /record size/,
  );
  process.env.TESTLOOM_SESSION_MODE = 'failure';
  const seen: string[] = [];
  await assert.rejects(
    claudeGenerate(project, scenario, f.snapshot, settings(), {
      session: { cwd, id },
      onSession: (value) => seen.push(value),
    }),
    /budget/,
  );
  assert.deepEqual(seen, [id]);
});
