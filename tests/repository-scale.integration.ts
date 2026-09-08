// Run explicitly: npx tsx tests/repository-scale.integration.ts
// Optional: TESTLOOM_SCALE_FILES=200000 (minimum 100000, maximum 1000000).
// Creates real files under work/, prints timing/memory evidence, and removes its own fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectProject, snapshotProject, type RepositoryProgress } from '../src/core/repository';

const fileCount = Number(process.env.TESTLOOM_SCALE_FILES ?? 100_000);
assert.ok(
  Number.isSafeInteger(fileCount) && fileCount >= 100_000 && fileCount < 1_000_000,
  'TESTLOOM_SCALE_FILES must be an integer between 100000 and 999999 (one manifest is also copied).',
);
const shardSize = 1000;
const manifest =
  JSON.stringify({
    name: 'real-large-source-fixture',
    devDependencies: { '@playwright/test': '*' },
  }) + '\n';
function relative(index: number) {
  return `src/shard-${String(Math.floor(index / shardSize)).padStart(4, '0')}/file-${String(index).padStart(6, '0')}${index % 20_000 === 0 ? '.spec' : ''}.ts`;
}
function content(index: number) {
  return `export const value${index} = ${index};\n`;
}
async function each(count: number, task: (index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (cursor < count) await task(cursor++);
    }),
  );
}
const mb = (bytes: number) => Math.round((bytes / 1024 ** 2) * 100) / 100;
const measurements: Record<string, unknown> = {};
async function measure<T>(label: string, task: () => Promise<T>): Promise<T> {
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let peakExternal = baseline.external;
  let peakBuffers = baseline.arrayBuffers;
  const sample = () => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeap = Math.max(peakHeap, current.heapUsed);
    peakExternal = Math.max(peakExternal, current.external);
    peakBuffers = Math.max(peakBuffers, current.arrayBuffers);
  };
  const timer = setInterval(sample, 20);
  const cpu = process.cpuUsage();
  const started = performance.now();
  try {
    return await task();
  } finally {
    sample();
    clearInterval(timer);
    const usedCpu = process.cpuUsage(cpu);
    const metric = {
      elapsedMs: Math.round(performance.now() - started),
      baselineRssMiB: mb(baseline.rss),
      peakRssMiB: mb(peakRss),
      peakHeapUsedMiB: mb(peakHeap),
      peakExternalMiB: mb(peakExternal),
      peakArrayBuffersMiB: mb(peakBuffers),
      cpuUserMs: Math.round(usedCpu.user / 1000),
      cpuSystemMs: Math.round(usedCpu.system / 1000),
      memorySamplingIntervalMs: 20,
    };
    measurements[label] = metric;
    console.log(JSON.stringify({ phase: label, ...metric }));
  }
}
await mkdir('work', { recursive: true });
const scratch = await mkdtemp(path.resolve('work/repository-scale-benchmark-'));
const source = path.join(scratch, 'source');
const target = path.join(scratch, 'snapshot');
const progress: Record<string, number> = { scan: 0, snapshot: 0 };
const onProgress = (event: RepositoryProgress) => {
  progress[event.phase]++;
};
let report: Record<string, unknown> | undefined;
try {
  await measure('fixtureCreation', async () => {
    await mkdir(source);
    await each(Math.ceil(fileCount / shardSize), async (index) => {
      await mkdir(path.join(source, `src/shard-${String(index).padStart(4, '0')}`), {
        recursive: true,
      });
    });
    await writeFile(path.join(source, 'package.json'), manifest, { mode: 0o600 });
    await each(fileCount, async (index) => {
      await writeFile(path.join(source, relative(index)), content(index), { mode: 0o600 });
    });
  });
  const combinedStart = performance.now();
  const project = await measure('inspect', () => inspectProject(source, { onProgress }));
  assert.equal(project.repository?.fileCount, fileCount + 1);
  assert.equal(project.framework, 'playwright-ts');
  assert.equal(project.examples.filter((file) => file.path.endsWith('.spec.ts')).length, 5);
  const snapshot = await measure('snapshotIncludingFreshScan', () =>
    snapshotProject(project, target, { onProgress }),
  );
  const scanPlusSnapshotMs = Math.round(performance.now() - combinedStart);
  assert.equal(snapshot.count, fileCount + 1);
  const provenance = JSON.parse(
    await readFile(path.join(target, '.journeyproof/provenance.json'), 'utf8'),
  );
  assert.equal(provenance.files, fileCount + 1);
  assert.equal(provenance.digest, snapshot.digest);
  // Independent expected bytes, mode, size, framing, and ordering; no private implementation helpers.
  const expected = createHash('sha256').update('sha256-sorted-file-manifest-v1\0');
  function addExpected(file: string, text: string) {
    expected.update(
      JSON.stringify([
        file,
        0o600,
        Buffer.byteLength(text),
        createHash('sha256').update(text).digest('hex'),
      ]) + '\n',
    );
  }
  addExpected('package.json', manifest);
  for (let index = 0; index < fileCount; index++) addExpected(relative(index), content(index));
  assert.equal(snapshot.digest, expected.digest('hex'));
  await measure('independentCopyVerification', async () => {
    assert.equal(await readFile(path.join(target, 'package.json'), 'utf8'), manifest);
    let actualCount = 1;
    await each(Math.ceil(fileCount / shardSize), async (index) => {
      const names = await readdir(path.join(target, `src/shard-${String(index).padStart(4, '0')}`));
      actualCount += names.length;
    });
    assert.equal(actualCount, fileCount + 1);
    await each(fileCount, async (index) => {
      assert.equal(await readFile(path.join(target, relative(index)), 'utf8'), content(index));
    });
    for (const index of [0, Math.floor(fileCount / 2), fileCount - 1]) {
      const before = await lstat(path.join(source, relative(index)));
      const copy = await lstat(path.join(target, relative(index)));
      assert.ok(copy.ino !== before.ino || copy.dev !== before.dev);
      assert.equal(copy.mode & 0o7777, before.mode & 0o7777);
    }
    await writeFile(path.join(target, relative(0)), '// snapshot edit\n');
    assert.equal(await readFile(path.join(source, relative(0)), 'utf8'), content(0));
  });
  report = {
    status: 'passed',
    platform: platform(),
    osRelease: release(),
    node: process.version,
    cpu: cpus()[0]?.model,
    sourceFiles: fileCount,
    snapshotFiles: snapshot.count,
    bytes: provenance.bytes,
    scanPlusSnapshotMs,
    measurements,
    clonedFiles: provenance.clonedFiles,
    streamedFiles: provenance.streamedFiles,
    digest: snapshot.digest,
    allCopiedFilesIndependentlyVerified: true,
    noOriginalHardlinks: true,
    progressCallbacks: progress,
    processPeakRssMiB: mb(process.resourceUsage().maxRSS * 1024),
    fixture: 'real tiny TypeScript files in 1000-file shards; freshly created local files',
  };
} finally {
  const started = performance.now();
  await rm(scratch, { recursive: true, force: true });
  if (report) {
    report.scratchRemoved = true;
    report.cleanupMs = Math.round(performance.now() - started);
    console.log(JSON.stringify(report, null, 2));
  }
}
