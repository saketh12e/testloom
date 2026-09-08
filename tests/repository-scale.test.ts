import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  inspectProject,
  listProjectFiles,
  snapshotProject,
  type RepositoryProgress,
} from '../src/core/repository';
import type { Project } from '../src/shared/types';

async function fixture(t: TestContext) {
  await mkdir('work', { recursive: true });
  const scratch = await mkdtemp(path.resolve('work/repository-scale-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  await mkdir(source);
  return { scratch, source, target: path.join(scratch, 'snapshot') };
}
function project(source: string): Project {
  return {
    id: 'scale',
    name: 'scale',
    path: source,
    framework: 'unknown',
    buildTool: 'Unconfigured',
    summary: '',
    examples: [],
    commands: [],
    outputDir: 'tests/testloom',
  };
}
async function populate(source: string, count: number) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (cursor < count) {
        const index = cursor++;
        await writeFile(
          path.join(source, `source-${String(index).padStart(6, '0')}.ts`),
          `export const n = ${index};\n`,
        );
      }
    }),
  );
}
async function missing(target: string) {
  await assert.rejects(lstat(target), { code: 'ENOENT' });
}
async function assertNoStaging(scratch: string) {
  assert.equal(
    (await readdir(scratch)).some((name) => name.includes('.testloom-')),
    false,
  );
}
async function copiedDigest(target: string) {
  const hash = createHash('sha256').update('sha256-sorted-file-manifest-v1\0');
  for (const file of (await listProjectFiles(target)).sort()) {
    const info = await lstat(path.join(target, file));
    const content = createHash('sha256')
      .update(await readFile(path.join(target, file)))
      .digest('hex');
    hash.update(
      JSON.stringify([file.split(path.sep).join('/'), info.mode & 0o7777, info.size, content]) +
        '\n',
    );
  }
  return hash.digest('hex');
}

test('inspection scans beyond 8,000 files and depth 16, with bounded examples and repository stats', async (t) => {
  const { source } = await fixture(t);
  await populate(source, 12_000);
  const deep = path.join(source, ...Array.from({ length: 24 }, (_, i) => `level-${i}`));
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, 'deep.spec.ts'), 'test("deep", () => {});');
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': '*' } }),
  );
  const events: (RepositoryProgress & { time: number })[] = [];
  const result = await inspectProject(source, {
    onProgress: (p) => events.push({ ...p, time: performance.now() }),
  });
  assert.equal(result.framework, 'playwright-ts');
  assert.match(result.summary, /^12002 source files/);
  const stats = (
    result as Project & {
      repository: { fileCount: number; scannedAt: string; scanDurationMs: number };
    }
  ).repository;
  assert.equal(stats.fileCount, 12_002);
  assert.ok(Number.isFinite(Date.parse(stats.scannedAt)));
  assert.ok(stats.scanDurationMs >= 0);
  assert.equal(result.examples.length, 2);
  assert.equal(events.filter((p) => p.phase === 'scan' && p.done).length, 1);
  assert.equal(events.at(-1)?.fileCount, 12_002);
  assert.ok(events.length <= Math.ceil(stats.scanDurationMs / 500) + 2);
  const periodic = events.filter((p) => !p.done);
  for (let i = 1; i < periodic.length; i++)
    assert.ok(periodic[i].time - periodic[i - 1].time >= 495);
});

test('ignores complete credential/cache descendants and never uses symlinked manifests or examples', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await writeFile(path.join(source, 'safe.ts'), 'export {};');
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'package.json'), '{"dependencies":{"playwright":"*"}}');
  await writeFile(path.join(outside, 'secret.spec.ts'), 'secret');
  for (const name of [
    '.git',
    'node_modules',
    '.cache',
    '__pycache__',
    '.env.local',
    '.aws',
    '.testloom',
  ]) {
    const deep = path.join(source, name, ...Array(66).fill('ignored'));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'secret.spec.ts'), 'secret');
  }
  for (const name of [
    '.npmrc',
    '.netrc',
    '.yarnrc.yml',
    'service.credentials.json',
    'token.pem',
    'private.key',
  ])
    await writeFile(path.join(source, name), 'secret');
  await symlink(path.join(outside, 'package.json'), path.join(source, 'package.json'));
  await symlink(path.join(outside, 'secret.spec.ts'), path.join(source, 'linked.spec.ts'));
  await symlink(outside, path.join(source, 'outside'));
  await symlink(source, path.join(source, 'loop'));
  const result = await inspectProject(source);
  assert.equal(result.framework, 'unknown');
  assert.deepEqual(result.examples, []);
  assert.deepEqual(await listProjectFiles(source), ['safe.ts']);
  assert.equal((await snapshotProject(result, target)).count, 1);
  assert.deepEqual((await readdir(target)).sort(), ['.journeyproof', 'safe.ts']);
});

test('snapshots have reproducible hashes of copied bytes, preserve modes and cannot modify original inodes', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await mkdir(path.join(source, 'scripts'));
  await writeFile(path.join(source, 'scripts/run.sh'), '#!/bin/sh\necho original\n');
  await chmod(path.join(source, 'scripts/run.sh'), 0o751);
  await chmod(path.join(source, 'scripts'), 0o750);
  for (const name of ['z.ts', 'a.ts', 'é.ts', 'a\nb.ts'])
    await writeFile(path.join(source, name), `// ${name}\n`);
  await chmod(path.join(source, 'a.ts'), 0o640);
  const first = await snapshotProject(project(source), target, { concurrency: 1 });
  const secondTarget = path.join(scratch, 'second');
  await mkdir(secondTarget);
  const progress: RepositoryProgress[] = [];
  const second = await snapshotProject(project(source), secondTarget, {
    concurrency: 8,
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(first, second);
  assert.equal(first.digest, await copiedDigest(target));
  assert.equal(first.digest, await copiedDigest(secondTarget));
  assert.equal(progress.filter((p) => p.phase === 'scan' && p.done).length, 1);
  assert.equal(progress.filter((p) => p.phase === 'snapshot' && p.done).length, 1);
  assert.equal(progress.at(-1)?.fileCount, 5);
  for (const name of ['scripts/run.sh', 'a.ts', 'scripts'])
    assert.equal(
      (await lstat(path.join(target, name))).mode & 0o7777,
      (await lstat(path.join(source, name))).mode & 0o7777,
    );
  const original = await lstat(path.join(source, 'scripts/run.sh'));
  const copy = await lstat(path.join(target, 'scripts/run.sh'));
  assert.ok(copy.dev !== original.dev || copy.ino !== original.ino);
  await writeFile(path.join(target, 'scripts/run.sh'), 'modified snapshot');
  assert.match(await readFile(path.join(source, 'scripts/run.sh'), 'utf8'), /original/);
  const provenance = JSON.parse(
    await readFile(path.join(secondTarget, '.journeyproof/provenance.json'), 'utf8'),
  );
  assert.equal(provenance.digest, second.digest);
  assert.equal(provenance.files, 5);
  assert.equal(provenance.clonedFiles + provenance.streamedFiles, 5);
  assert.equal(provenance.bytes, progress.at(-1)?.bytesCopied);
  await chmod(path.join(source, 'a.ts'), 0o600);
  const modeChanged = await snapshotProject(project(source), path.join(scratch, 'different-mode'));
  assert.notEqual(modeChanged.digest, first.digest);
});

test('streams files and snapshots beyond the previous 20 MB and 250 MB limits', async (t) => {
  const { source, target } = await fixture(t);
  const size = 256 * 1024 ** 2;
  const file = await open(path.join(source, 'large.ts'), 'w');
  try {
    await file.truncate(size);
    await file.write(Buffer.from('start'), 0, 5, 0);
    await file.write(Buffer.from('end'), 0, 3, size - 3);
  } finally {
    await file.close();
  }
  const events: RepositoryProgress[] = [];
  const result = await snapshotProject(project(source), target, {
    onProgress: (p) => events.push(p),
  });
  assert.equal(result.count, 1);
  assert.equal((await lstat(path.join(target, 'large.ts'))).size, size);
  assert.equal(events.at(-1)?.bytesCopied, size);
  const copy = await open(path.join(target, 'large.ts'), 'r');
  try {
    const start = Buffer.alloc(5);
    const end = Buffer.alloc(3);
    await copy.read(start, 0, 5, 0);
    await copy.read(end, 0, 3, size - 3);
    assert.equal(start.toString(), 'start');
    assert.equal(end.toString(), 'end');
  } finally {
    await copy.close();
  }
});

test('configured file, depth, per-file and aggregate limits fail clearly without publishing partial work', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await populate(source, 3);
  await assert.rejects(listProjectFiles(source, 2), /limit of 2 source files/);
  await assert.rejects(
    snapshotProject(project(source), target, { maxFileBytes: 2 }),
    /per-file snapshot limit/,
  );
  await missing(target);
  await assert.rejects(
    snapshotProject(project(source), target, { maxTotalBytes: 25, concurrency: 3 }),
    /total source snapshot limit/,
  );
  await missing(target);
  await mkdir(path.join(source, 'one/two'), { recursive: true });
  await assert.rejects(inspectProject(source, { maxDepth: 1 }), /directory depth of 1/);
  await assert.rejects(inspectProject(source, { concurrency: 100_000 }), /concurrency/);
  await assert.rejects(inspectProject(source, { maxFiles: Infinity }), /Invalid repository option/);
  await assertNoStaging(scratch);
});

test('pre-aborted and mid-scan operations reject with AbortError and close their directory handles', async (t) => {
  const { source, target } = await fixture(t);
  await populate(source, 150);
  const stopped = AbortSignal.abort();
  await assert.rejects(inspectProject(source, { signal: stopped }), { name: 'AbortError' });
  await assert.rejects(snapshotProject(project(source), target, { signal: stopped }), {
    name: 'AbortError',
  });
  const controller = new AbortController();
  await assert.rejects(
    inspectProject(source, {
      signal: controller.signal,
      progressIntervalMs: 0,
      onProgress: (p) => {
        if (p.fileCount >= 10) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  await missing(target);
  assert.equal((await listProjectFiles(source)).length, 150);
});

test('cancellation during a file copy drains workers and removes only its own staging directory', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await writeFile(path.join(scratch, 'unrelated.txt'), 'keep');
  await writeFile(path.join(source, 'large.ts'), Buffer.alloc(4 * 1024 ** 2, 97));
  await populate(source, 40);
  await mkdir(target); // Existing empty callers remain intact on failure.
  const controller = new AbortController();
  let completed = false;
  await assert.rejects(
    snapshotProject(project(source), target, {
      signal: controller.signal,
      progressIntervalMs: 0,
      concurrency: 8,
      onProgress: (p) => {
        if (p.phase === 'snapshot' && p.bytesCopied > 0) controller.abort();
        if (p.phase === 'snapshot' && p.done) completed = true;
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(completed, false);
  assert.deepEqual(await readdir(target), []);
  assert.equal(await readFile(path.join(scratch, 'unrelated.txt'), 'utf8'), 'keep');
  await assertNoStaging(scratch);
});

test('source mutation while copying cannot publish provenance for a different source identity', async (t) => {
  const { scratch, source, target } = await fixture(t);
  const file = path.join(source, 'large.ts');
  await writeFile(file, Buffer.alloc(2 * 1024 ** 2, 97));
  let mutated = false;
  await assert.rejects(
    snapshotProject(project(source), target, {
      progressIntervalMs: 0,
      onProgress: (p) => {
        if (!mutated && p.phase === 'snapshot' && p.bytesCopied > 0) {
          mutated = true;
          writeFileSync(file, Buffer.alloc(2 * 1024 ** 2, 98));
        }
      },
    }),
    /Project changed/,
  );
  assert.equal(mutated, true);
  await missing(target);
  await assertNoStaging(scratch);
});

test('rejects source directory symlink swaps after enumeration and destination aliases into the source', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await mkdir(path.join(source, 'tree'));
  await writeFile(path.join(source, 'tree/example.ts'), 'public');
  const outside = path.join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'example.ts'), 'outside secret');
  await assert.rejects(
    snapshotProject(project(source), target, {
      onProgress: (p) => {
        if (p.phase === 'scan' && p.done) {
          renameSync(path.join(source, 'tree'), path.join(source, 'saved-tree'));
          symlinkSync(outside, path.join(source, 'tree'));
        }
      },
    }),
    /symlink|changed|escaped/,
  );
  await missing(target);
  await symlink(source, path.join(scratch, 'source-alias'));
  await assert.rejects(
    snapshotProject(project(source), path.join(scratch, 'source-alias/new/child')),
    /outside the connected project/,
  );
  await missing(path.join(source, 'new'));
  await symlink(outside, target);
  await assert.rejects(snapshotProject(project(source), target), /symlink/);
  assert.equal(await readFile(path.join(outside, 'example.ts'), 'utf8'), 'outside secret');
  await assertNoStaging(scratch);
});

test('refuses nonempty destinations and callback failures settle before staging cleanup', async (t) => {
  const { scratch, source, target } = await fixture(t);
  await populate(source, 40);
  await mkdir(target);
  await writeFile(path.join(target, 'keep.txt'), 'keep');
  await assert.rejects(snapshotProject(project(source), target), /empty directory/);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  const other = path.join(scratch, 'other');
  await assert.rejects(
    snapshotProject(project(source), other, {
      progressIntervalMs: 0,
      onProgress: (p) => {
        if (p.phase === 'snapshot' && p.fileCount > 0) throw new Error('observer failed');
      },
    }),
    /observer failed/,
  );
  await missing(other);
  await assertNoStaging(scratch);
});
