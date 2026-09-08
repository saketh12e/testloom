import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pinnedBrowser, verifyRecordingBrowser } from './verify-recording-browser.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--arch', '--output'].includes(key) || !args[index + 1] || parsed[key])
      throw new Error('Expected --arch arm64|x64 and --output <directory>.');
    parsed[key] = args[index + 1];
  }
  if (!['arm64', 'x64'].includes(parsed['--arch']) || !parsed['--output'])
    throw new Error('Expected --arch arm64|x64 and --output <directory>.');
  return { arch: parsed['--arch'], output: path.resolve(parsed['--output']) };
}

export function browserInstallEnvironment(arch, cache, inherited = process.env) {
  if (!['arm64', 'x64'].includes(arch) || !path.isAbsolute(cache))
    throw new Error('Invalid browser staging configuration.');
  const env = { ...inherited };
  // Keep corporate proxy/CA configuration, but do not allow an inherited cache,
  // download override or injected Node/Electron code to affect the release.
  for (const key of Object.keys(env)) {
    if (
      /^(PLAYWRIGHT_|PW_TEST_|DYLD_|LD_)/.test(key) ||
      [
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'ELECTRON_RUN_AS_NODE',
      ].includes(key)
    )
      delete env[key];
  }
  return {
    ...env,
    TMPDIR: path.join(path.dirname(cache), 'downloads'),
    TMP: path.join(path.dirname(cache), 'downloads'),
    TEMP: path.join(path.dirname(cache), 'downloads'),
    PLAYWRIGHT_BROWSERS_PATH: cache,
    // Verified in pinned Playwright coreBundle.js: calculatePlatform and
    // DOWNLOAD_PATHS.chromium. mac14 is the supported baseline for both CPUs.
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: arch === 'arm64' ? 'mac14-arm64' : 'mac14',
    PLAYWRIGHT_SKIP_BROWSER_GC: '1',
    CI: '1',
  };
}

export async function prepareRecordingBrowser({ arch, output }) {
  if (process.platform !== 'darwin')
    throw new Error(
      'Prepare Mac recording browsers on macOS to preserve app resources and symlinks.',
    );
  if (
    !['arm64', 'x64'].includes(arch) ||
    !path.isAbsolute(output) ||
    output === path.parse(output).root
  )
    throw new Error('Invalid output directory or architecture.');
  try {
    await lstat(output);
    // Never delete or overwrite a caller-supplied directory. A verified exact
    // artifact can be reused; upgrades must choose a fresh output directory.
    const existing = await verifyRecordingBrowser(output, { arch });
    console.log(`Reusing verified recording browser for ${existing.arch}.`);
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // An existing incomplete directory must also fail closed.
    try {
      await lstat(output);
      throw new Error('Output exists but is incomplete; choose a fresh output directory.');
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing;
    }
  }
  const versions = await pinnedBrowser();
  const playwrightRoot = path.dirname(require.resolve('playwright/package.json'));
  const coreRoot = path.dirname(require.resolve('playwright-core/package.json'));
  const source = await readFile(path.join(coreRoot, 'lib/coreBundle.js'), 'utf8');
  if (
    !source.includes('process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE') ||
    !source.includes('"mac14-arm64"') ||
    !source.includes('"mac14"')
  ) {
    throw new Error(
      'Pinned Playwright changed its platform override; review download selection before shipping.',
    );
  }
  await mkdir(path.dirname(output), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(output), '.testloom-browser-stage-'));
  try {
    const cache = path.join(stage, 'cache');
    const prepared = path.join(stage, 'recording-browser');
    const env = browserInstallEnvironment(arch, cache);
    await mkdir(env.TMPDIR);
    console.log(
      `Downloading pinned Playwright ${versions.playwrightVersion} full Chromium for ${arch} into isolated staging.`,
    );
    const installation = run(
      process.execPath,
      [path.join(playwrightRoot, 'cli.js'), 'install', 'chromium', '--no-shell', '--no-remove'],
      { env, timeout: 900_000, maxBuffer: 4 * 1024 * 1024 },
    );
    installation.child.stdout?.pipe(process.stdout);
    installation.child.stderr?.pipe(process.stderr);
    try {
      await installation;
    } catch (error) {
      if (error.killed)
        throw new Error(
          'Pinned recording-browser download exceeded 15 minutes. Check the build machine network and retry; no incomplete browser was published.',
        );
      throw error;
    }
    // Ask the same pinned installation for its executable path; do not guess
    // Chromium revision directories or construct Chrome-for-Testing URLs.
    const result = await run(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require(process.argv[1]).chromium.executablePath())',
        playwrightRoot,
      ],
      { env, timeout: 30_000 },
    );
    const executable = result.stdout.trim();
    const relative = path.relative(cache, executable);
    if (
      path.isAbsolute(relative) ||
      relative.startsWith('..') ||
      !relative.includes('.app/Contents/MacOS/')
    )
      throw new Error('Playwright resolved a browser outside the isolated cache.');
    const [browserDirectory, ...executableParts] = relative.split(path.sep);
    if (!/^chromium-\d+$/.test(browserDirectory))
      throw new Error('Pinned Playwright browser layout changed; review packaging.');
    await mkdir(prepared);
    // Copy the complete browser directory, not only its launcher or .app;
    // preserve relative framework symlinks and external bundled resources.
    await cp(path.join(cache, browserDirectory), path.join(prepared, 'chromium'), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    const manifest = {
      schemaVersion: 1,
      ...versions,
      platform: 'darwin',
      arch,
      executable: ['chromium', ...executableParts].join('/'),
    };
    await writeFile(
      path.join(prepared, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx' },
    );
    const verified = await verifyRecordingBrowser(prepared, { arch });
    await rename(prepared, output);
    console.log(
      `Prepared and verified ${arch} full recording browser (${verified.files} files, ${verified.binaries} Mach-O binaries).`,
    );
    return verified;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareRecordingBrowser(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
