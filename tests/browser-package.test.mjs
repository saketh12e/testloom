import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  browserInstallEnvironment,
  parseArguments,
  prepareRecordingBrowser,
} from '../scripts/prepare-recording-browser.mjs';
import {
  machoArchitectures,
  pinnedBrowser,
  validateManifest,
  verifyRecordingBrowser,
} from '../scripts/verify-recording-browser.mjs';

const versions = await pinnedBrowser();
const manifest = {
  schemaVersion: 1,
  ...versions,
  platform: 'darwin',
  arch: 'arm64',
  executable: 'chromium/Browser.app/Contents/MacOS/Browser',
};

test('manifest rejects private metadata, unsafe paths, stale versions and architecture mismatches', () => {
  assert.deepEqual(validateManifest(manifest, versions), manifest);
  for (const executable of [
    '/tmp/Browser.app/Contents/MacOS/Browser',
    '../Browser.app/Contents/MacOS/Browser',
    'a/../Browser.app/Contents/MacOS/Browser',
    'a\\Browser.app/Contents/MacOS/Browser',
    'https://example.test/Browser.app/Contents/MacOS/Browser',
    'a//Browser.app/Contents/MacOS/Browser',
    'Browser.app/Contents/MacOS/Browser\n',
  ]) {
    assert.throws(() => validateManifest({ ...manifest, executable }), /safe relative/);
  }
  assert.throws(() => validateManifest({ ...manifest, machinePath: '/Users/private' }), /Invalid/);
  assert.throws(() => validateManifest({ ...manifest, schemaVersion: 2 }), /Invalid/);
  assert.throws(
    () => validateManifest({ ...manifest, playwrightVersion: [versions.playwrightVersion] }),
    /Invalid/,
  );
  assert.throws(() => validateManifest({ ...manifest, arch: 'universal' }), /Invalid/);
  assert.throws(() => validateManifest(manifest, { arch: 'x64' }), /arch mismatch/);
  assert.throws(
    () => validateManifest(manifest, { playwrightVersion: '0.0.1' }),
    /playwrightVersion mismatch/,
  );
  assert.throws(
    () => validateManifest(manifest, { browserVersion: '0.0.0.1' }),
    /browserVersion mismatch/,
  );
});

test('installer owns its cache and selects both pinned Mac architecture mappings', () => {
  const inherited = {
    PLAYWRIGHT_BROWSERS_PATH: '/global',
    PLAYWRIGHT_DOWNLOAD_HOST: 'https://wrong.example',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'linux',
    PW_TEST_CDN_THAT_SHOULD_WORK: 'bad',
    NODE_OPTIONS: '--require private.js',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    ELECTRON_RUN_AS_NODE: '1',
    DYLD_INSERT_LIBRARIES: 'private.dylib',
    HTTPS_PROXY: 'https://proxy.example',
    NODE_EXTRA_CA_CERTS: '/corporate/ca.pem',
  };
  for (const arch of ['arm64', 'x64']) {
    const env = browserInstallEnvironment(arch, '/owned/cache', inherited);
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/owned/cache');
    assert.equal(env.TMPDIR, '/owned/downloads');
    assert.equal(env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, arch === 'arm64' ? 'mac14-arm64' : 'mac14');
    assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
    assert.equal(env.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
    for (const key of [
      'PLAYWRIGHT_DOWNLOAD_HOST',
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
      'PW_TEST_CDN_THAT_SHOULD_WORK',
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'ELECTRON_RUN_AS_NODE',
      'DYLD_INSERT_LIBRARIES',
    ])
      assert.equal(env[key], undefined);
  }
  assert.equal(inherited.PLAYWRIGHT_BROWSERS_PATH, '/global');
  assert.throws(() => browserInstallEnvironment('universal', '/owned/cache'));
  assert.throws(() => browserInstallEnvironment('arm64', 'relative/cache'));
});

test('preparation CLI requires an explicit supported architecture and destination', () => {
  assert.deepEqual(parseArguments(['--output', 'work/browser', '--arch', 'x64']), {
    arch: 'x64',
    output: path.resolve('work/browser'),
  });
  for (const args of [
    [],
    ['--arch', 'arm64'],
    ['--arch', 'universal', '--output', '/tmp/a'],
    ['--arch', 'arm64', '--output', '/tmp/a', '--force', 'true'],
    ['--arch', 'arm64', '--arch', 'x64', '--output', '/tmp/a'],
  ])
    assert.throws(() => parseArguments(args));
});

test('Mach-O inspection distinguishes ARM, Intel, universal, non-binaries and malformed headers', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-macho-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [arch, cpu] of [
    ['arm64', 16777228],
    ['x64', 16777223],
  ]) {
    const header = Buffer.alloc(32);
    header.writeUInt32BE(0xcffaedfe);
    header.writeUInt32LE(cpu, 4);
    const filename = path.join(root, arch);
    await writeFile(filename, header);
    assert.deepEqual(await machoArchitectures(filename), [arch]);
  }
  const filename = path.join(root, 'fat');
  const header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(16777228, 8);
  header.writeUInt32BE(16777223, 28);
  await writeFile(filename, header);
  assert.deepEqual(await machoArchitectures(filename), ['arm64', 'x64']);
  header.writeUInt32BE(1000, 4);
  await writeFile(filename, header);
  await assert.rejects(machoArchitectures(filename), /Malformed/);
  await writeFile(filename, '#!/bin/sh\nexit 0\n');
  assert.deepEqual(await machoArchitectures(filename), []);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-browser-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'recording-browser');
  const current = { ...manifest, arch: process.arch };
  const executable = path.join(directory, current.executable);
  const app = path.dirname(path.dirname(path.dirname(executable)));
  const framework = path.join(
    app,
    'Contents/Frameworks/Browser Framework.framework/Versions',
    versions.browserVersion,
  );
  async function put(relative, data = 'resource') {
    const filename = path.join(directory, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
    return filename;
  }
  await mkdir(path.dirname(executable), { recursive: true });
  execFileSync('/usr/bin/clang', ['-x', 'c', '-', '-o', executable], {
    input: 'int main(void) { return 0; }',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await put('manifest.json', JSON.stringify(current));
  await put(
    'chromium/Browser.app/Contents/Info.plist',
    `<plist><dict><key>CFBundleShortVersionString</key><string>${versions.browserVersion}</string><key>CFBundleExecutable</key><string>Browser</string></dict></plist>`,
  );
  for (const resource of [
    'Resources/icudtl.dat',
    'Resources/resources.pak',
    'Resources/en.lproj/locale.pak',
    `Resources/v8_context_snapshot.${process.arch === 'x64' ? 'x86_64' : 'arm64'}.bin`,
  ])
    await put(path.relative(directory, path.join(framework, resource)));
  await put('chromium/Browser.app/Contents/Resources/icon.icns');
  for (const binary of [
    'Browser Framework',
    'Helpers/Browser Helper (Renderer).app/Contents/MacOS/Renderer',
    'Helpers/Browser Helper (GPU).app/Contents/MacOS/GPU',
    'Helpers/chrome_crashpad_handler',
    'Libraries/libexample.dylib',
  ]) {
    const filename = path.join(framework, binary);
    await mkdir(path.dirname(filename), { recursive: true });
    await cp(executable, filename);
  }
  return { directory, current, framework, executable, root };
}

test(
  'bundle verification accepts complete resources and rejects missing helpers, changed app versions and escaping symlinks',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { directory, framework, current, root } = await fixture(t);
    assert.equal((await verifyRecordingBrowser(directory, { arch: process.arch })).binaries, 6);
    const helper = path.join(framework, 'Helpers/chrome_crashpad_handler');
    await rm(helper);
    await assert.rejects(verifyRecordingBrowser(directory), /missing full browser resources/);
    await cp(path.join(directory, current.executable), helper);
    const outside = path.join(root, 'private');
    await writeFile(outside, 'private');
    await symlink(outside, path.join(directory, 'escaping'));
    await assert.rejects(verifyRecordingBrowser(directory), /escaping symlink/);
    await rm(path.join(directory, 'escaping'));
    const info = path.join(directory, 'chromium/Browser.app/Contents/Info.plist');
    await writeFile(
      info,
      (await readFile(info, 'utf8')).replace(versions.browserVersion, '0.0.0.1'),
    );
    await assert.rejects(verifyRecordingBrowser(directory), /app version/);
  },
);

test(
  'prepare refuses incomplete output without deleting unrelated contents or starting downloads',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloom-browser-owned-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'sentinel'), 'keep');
    await assert.rejects(
      prepareRecordingBrowser({ arch: process.arch, output: root }),
      /incomplete/,
    );
    assert.equal(await readFile(path.join(root, 'sentinel'), 'utf8'), 'keep');
  },
);

test(
  'built app and extracted ZIP must contain the matching Playwright dependency and browser',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { directory, root, executable } = await fixture(t);
    const app = path.join(root, 'Testloom.app');
    const resources = path.join(app, 'Contents/Resources');
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    await cp(executable, path.join(app, 'Contents/MacOS/Testloom'));
    await cp(directory, path.join(resources, 'recording-browser'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const packages = path.join(resources, 'app.asar.unpacked/node_modules');
    for (const name of ['playwright', 'playwright-core']) {
      await mkdir(path.join(packages, name), { recursive: true });
      await writeFile(
        path.join(packages, name, 'package.json'),
        JSON.stringify({ version: versions.playwrightVersion }),
      );
    }
    await writeFile(
      path.join(packages, 'playwright-core/browsers.json'),
      JSON.stringify({ browsers: [{ name: 'chromium', browserVersion: versions.browserVersion }] }),
    );
    assert.equal((await verifyRecordingBrowser(app)).arch, process.arch);
    const zip = path.join(root, 'release.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    assert.equal((await verifyRecordingBrowser(zip)).arch, process.arch);
    await writeFile(
      path.join(packages, 'playwright-core/package.json'),
      JSON.stringify({ version: '0.0.1' }),
    );
    await assert.rejects(verifyRecordingBrowser(app), /Packaged Playwright/);
  },
);
