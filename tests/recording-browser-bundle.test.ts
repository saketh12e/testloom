import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import playwrightPackage from 'playwright/package.json';
import {
  bundledBrowserExecutable,
  checkRecordingPlatform,
} from '../src/core/recording-browser-bundle';

test('bundled executable must match this runtime and remain inside its bundle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-browser-bundle-'));
  const bundle = path.join(root, 'bundle');
  await mkdir(bundle);
  await writeFile(path.join(bundle, 'browser'), 'synthetic executable', { mode: 0o700 });
  await writeFile(path.join(root, 'outside'), 'synthetic outside', { mode: 0o700 });
  await symlink(path.join(root, 'outside'), path.join(bundle, 'escape'));
  const valid = {
    schemaVersion: 1,
    playwrightVersion: playwrightPackage.version,
    browserVersion: '1.0',
    platform: process.platform,
    arch: process.arch,
    executable: 'browser',
  };
  try {
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(valid));
    assert.equal(
      await bundledBrowserExecutable(bundle),
      await realpath(path.join(bundle, 'browser')),
    );
    for (const invalid of [
      null,
      [],
      {},
      { ...valid, executable: '../outside' },
      { ...valid, executable: 'escape' },
      { ...valid, executable: '/bin/sh' },
      { ...valid, executable: 'absent' },
      { ...valid, arch: 'wrong' },
      { ...valid, platform: 'wrong' },
      { ...valid, playwrightVersion: '0.1' },
    ]) {
      await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(invalid));
      await assert.rejects(bundledBrowserExecutable(bundle), /TESTLOOM_BUNDLE_INVALID/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS compatibility is checked before browser launch', () => {
  assert.throws(() => checkRecordingPlatform('darwin', '22.6.0'), /TESTLOOM_MACOS_UNSUPPORTED/);
  assert.doesNotThrow(() => checkRecordingPlatform('darwin', '23.0.0'));
  assert.doesNotThrow(() => checkRecordingPlatform('darwin', '25.0.0'));
  assert.doesNotThrow(() => checkRecordingPlatform('linux', '6.8.0'));
});
