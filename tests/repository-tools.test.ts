import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, link, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { executeRepositoryTool, REPOSITORY_TOOL_DEFINITIONS } from '../src/core/repository-tools';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'testloom-repository-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(name: string, content = '') {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const call = async (
    name: string,
    args: unknown,
    exclusions: string[] = [],
    signal?: AbortSignal,
  ) => JSON.parse(await executeRepositoryTool(root, exclusions, name, args, signal));
  return { root, put, call };
}

test('repository tools expose bounded schemas and reject malformed input', async (t) => {
  const f = await fixture(t);
  assert.equal(REPOSITORY_TOOL_DEFINITIONS.length, 4);
  for (const [name, args] of [
    ['unknown', {}],
    ['repository_list', []],
    ['repository_list', { limit: 201 }],
    ['repository_list', { command: 'cat' }],
    ['repository_search_paths', {}],
    ['repository_search_paths', { glob: '../*' }],
    ['repository_read', { path: 'a', maxBytes: 65537 }],
    ['repository_grep', { query: 'x', timeoutMs: 5001 }],
    ['repository_grep', { query: '' }],
  ] as const)
    await assert.rejects(f.call(name, args));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.call('repository_list', {}, [], controller.signal), /cancelled/);
});

test('list pagination and path substring/glob queries honor directory exclusions', async (t) => {
  const f = await fixture(t);
  for (const file of [
    'a.ts',
    'src/cart.ts',
    'src/cart.test.ts',
    'src/nested/cart.ts',
    'src/private/hidden.ts',
    'vendor/x.ts',
  ])
    await f.put(file);
  const exclusions = ['**/private/**', 'vendor', '**/*.test.ts'];
  const first = await f.call('repository_list', { limit: 2 }, exclusions);
  assert.equal(first.paths.length, 2);
  assert.equal(first.truncated, true);
  const seen = new Set<string>(first.paths);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await f.call('repository_list', { limit: 2, cursor }, exclusions);
    for (const file of page.paths) {
      assert.ok(!seen.has(file));
      seen.add(file);
    }
    cursor = page.nextCursor;
  }
  assert.deepEqual([...seen].sort(), ['a.ts', 'src/cart.ts', 'src/nested/cart.ts']);
  const match = await f.call(
    'repository_search_paths',
    { query: 'CART', glob: '**/*.ts', path: 'src' },
    exclusions,
  );
  assert.deepEqual(match.paths.sort(), ['src/cart.ts', 'src/nested/cart.ts']);
  await assert.rejects(
    f.call('repository_list', { path: 'src', cursor: first.nextCursor }, exclusions),
    /Cursor/,
  );
  await assert.rejects(
    f.call('repository_read', { path: 'src/private/hidden.ts' }, exclusions),
    /excluded/,
  );
});

test('all tools deny traversal, credential/config paths, symlinks and linked-file escapes', async (t) => {
  const f = await fixture(t);
  const denied = [
    '.git/config',
    '.codex/auth.json',
    '.claude/settings.json',
    '.config/credentials',
    '.env',
    '.env.local',
    'AGENTS.md',
    'src/CLAUDE.md',
    '.mcp.json',
    '.npmrc',
    '.yarnrc.yml',
    '.netrc',
    '.git-credentials',
    'keys/id_rsa',
    'secrets.json',
  ];
  for (const file of denied) await f.put(file, 'PRIVATE_CREDENTIAL');
  await f.put('allowed.txt', 'public content');
  await f.put('nested/visible.txt', 'visible');
  await symlink(path.join(f.root, 'nested'), path.join(f.root, 'alias'));
  await symlink(path.join(f.root, '.env'), path.join(f.root, 'secret-link'));
  await link(path.join(f.root, '.env'), path.join(f.root, 'secret-hardlink'));
  for (const file of [
    ...denied,
    '../outside',
    '/etc/passwd',
    'nested/../../outside',
    'nested\\visible.txt',
    'C:/secret',
    'alias/visible.txt',
    'secret-link',
    'secret-hardlink',
  ])
    await assert.rejects(f.call('repository_read', { path: file }));
  await assert.rejects(
    executeRepositoryTool(path.join(f.root, 'alias'), [], 'repository_list', {}),
    /symlink/,
  );
  await assert.rejects(
    executeRepositoryTool(path.join(f.root, 'alias', 'missing'), [], 'repository_list', {}),
  );
  await assert.rejects(executeRepositoryTool(path.join(f.root, '.git'), [], 'repository_list', {}));
  const listed = await f.call('repository_list', {});
  assert.ok(denied.every((p) => !listed.paths.includes(p)));
  assert.ok(!listed.paths.includes('alias/visible.txt'));
  // The hardlink's otherwise innocent name may be enumerated, but contents fail closed.
  await assert.rejects(f.call('repository_grep', { query: 'PRIVATE' }));
});

test('read is byte/line bounded, Unicode-safe, scrubbed and has usable continuation', async (t) => {
  const f = await fixture(t);
  const content = 'αβ\nsecond\nthird\nfourth\n';
  await f.put('source.txt', content);
  let offset = 0,
    reconstructed = '';
  do {
    const result = await f.call('repository_read', {
      path: 'source.txt',
      offset,
      maxLines: 2,
      maxBytes: 20,
    });
    assert.ok(Buffer.byteLength(result.content) <= 20);
    assert.ok(result.returnedLines <= 2);
    reconstructed += result.content;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, content);
  assert.equal(
    (await f.call('repository_read', { path: 'source.txt', startLine: 3 })).content,
    'third\nfourth\n',
  );
  await f.put(
    'config.ts',
    'password = superprivatevalue\nurl="https://name:passwd@host/?token=hidden"\nconst publicValue = 7;\n',
  );
  const scrubbed = await f.call('repository_read', { path: 'config.ts' });
  assert.doesNotMatch(scrubbed.content, /superprivatevalue|name:passwd|token=hidden/);
  assert.match(scrubbed.content, /REDACTED/);
  const partial = await f.call('repository_read', { path: 'config.ts', offset: 15 });
  assert.doesNotMatch(partial.content, /privatevalue/);
  const queried = await f.call('repository_grep', { query: 'superprivatevalue' });
  assert.equal(queried.matches.length, 0);
  await f.put('long.txt', 'x'.repeat(100_000) + '\nvisible\n');
  const long = await f.call('repository_read', { path: 'long.txt', maxBytes: 20 });
  assert.equal(long.content, 'visible\n');
  assert.equal(long.omittedLines, 1);
  assert.equal(long.truncated, true);
  await f.put('binary.dat', 'hello\x00world');
  await assert.rejects(f.call('repository_read', { path: 'binary.dat' }), /text files/);
});

test('grep bounds results and actual scanned bytes and reports incomplete search', async (t) => {
  const f = await fixture(t);
  await f.put('src/many.ts', 'needle a\nneedle b\nneedle c\n');
  await f.put('private/secret.ts', 'needle secret');
  const results = await f.call('repository_grep', { query: 'needle', maxResults: 2 }, [
    'private/**',
  ]);
  assert.equal(results.matches.length, 2);
  assert.equal(results.truncated, true);
  assert.ok(results.reasons.includes('result_limit'));
  const bytes = await f.call('repository_grep', { query: 'absent', maxBytes: 10 });
  assert.ok(bytes.scannedBytes <= 10);
  assert.equal(bytes.truncated, true);
  assert.ok(bytes.reasons.includes('byte_limit'));
  const oversized = await open(path.join(f.root, 'large.txt'), 'w');
  await oversized.truncate(2 * 1024 * 1024);
  await oversized.close();
  const binary = await f.call('repository_grep', { query: 'needle', glob: 'large.txt' });
  assert.equal(binary.skippedFiles, 1);
});

test(
  'a 100,001-file repository remains searchable without serializing its path inventory',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    for (let group = 0; group < 100; group++) {
      const dir = path.join(f.root, `group-${String(group).padStart(3, '0')}`);
      await mkdir(dir);
      for (let batch = 0; batch < 10; batch++)
        await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            writeFile(path.join(dir, `file-${batch * 100 + i}.ts`), ''),
          ),
        );
    }
    await f.put('group-099/the-final-helper.ts', 'export const value = 42;');
    const result = await f.call('repository_search_paths', { query: 'the-final-helper' });
    assert.deepEqual(result.paths, ['group-099/the-final-helper.ts']);
    assert.equal(result.truncated, false);
    assert.ok(result.scannedEntries > 100_000);
    assert.ok(JSON.stringify(result).length < 1000);
    const page = await f.call('repository_list', { limit: 200 });
    assert.equal(page.paths.length, 200);
    assert.ok(JSON.stringify(page).length < 20_000);
  },
);

test('bundled MCP server negotiates stdio protocol, runs tools, handles errors and cancellation', async (t) => {
  const f = await fixture(t);
  await f.put('source.ts', 'const marker = 42;\n');
  const server = path.join(f.root, 'server.cjs');
  await build({
    entryPoints: [path.resolve('src/core/repository-mcp.ts')],
    outfile: server,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const child = spawn(process.execPath, [server, f.root, JSON.stringify(['server.cjs'])], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill();
  });
  let buffer = '',
    diagnostics = '';
  const replies = new Map<number, any>();
  const waiting = new Map<number, (value: any) => void>();
  child.stderr.on('data', (data) => (diagnostics += data.toString()));
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      assert.equal(value.jsonrpc, '2.0');
      replies.set(value.id, value);
      waiting.get(value.id)?.(value);
    }
  });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const reply = (id: number): Promise<any> =>
    replies.has(id)
      ? Promise.resolve(replies.get(id))
      : new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('MCP response timeout')), 5000);
          waiting.set(id, (value) => {
            clearTimeout(timeout);
            waiting.delete(id);
            resolve(value);
          });
        });
  send({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert.equal((await reply(0)).error.code, -32002);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  assert.equal((await reply(1)).result.protocolVersion, '2025-11-25');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal((await reply(2)).result.tools.length, 4);
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'repository_read', arguments: { path: 'source.ts' } },
  });
  const read = await reply(3);
  assert.equal(read.result.isError, false);
  assert.match(JSON.parse(read.result.content[0].text).content, /marker/);
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'repository_read', arguments: { path: '../private' } },
  });
  assert.equal((await reply(4)).result.isError, true);
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'repository_grep', arguments: { query: 'marker' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  await reply(6);
  send({ jsonrpc: '2.0', id: 7, method: 'unknown' });
  assert.equal((await reply(7)).error.code, -32601);
  child.stdin.end();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(replies.has(5), false);
  assert.equal(diagnostics, '');
  assert.equal(replies.has(undefined as any), false);
});
