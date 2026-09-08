import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export async function pinnedBrowser() {
  const playwright = require('playwright/package.json');
  const corePath = path.dirname(require.resolve('playwright-core/package.json'));
  const core = JSON.parse(await readFile(path.join(corePath, 'package.json'), 'utf8'));
  const { browsers } = JSON.parse(await readFile(path.join(corePath, 'browsers.json'), 'utf8'));
  const chromium = browsers.find((browser) => browser.name === 'chromium');
  if (playwright.version !== core.version || !chromium?.browserVersion) {
    throw new Error('Playwright and playwright-core must use the same pinned version.');
  }
  return { playwrightVersion: playwright.version, browserVersion: chromium.browserVersion };
}

export function validateManifest(manifest, expected = {}) {
  if (
    !manifest ||
    Object.keys(manifest).sort().join(',') !==
      'arch,browserVersion,executable,platform,playwrightVersion,schemaVersion' ||
    manifest.schemaVersion !== 1 ||
    manifest.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(manifest.arch) ||
    typeof manifest.playwrightVersion !== 'string' ||
    typeof manifest.browserVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.playwrightVersion) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(manifest.browserVersion)
  ) {
    throw new Error('Invalid recording-browser manifest.');
  }
  const executable = manifest.executable;
  if (
    typeof executable !== 'string' ||
    executable.length > 500 ||
    executable.includes('\\') ||
    /[\x00-\x1f:]/.test(executable) ||
    executable.split('/').some((part) => !part || part === '.' || part === '..') ||
    !executable.includes('.app/Contents/MacOS/')
  ) {
    throw new Error('Recording-browser executable must be a safe relative app executable path.');
  }
  for (const key of ['arch', 'playwrightVersion', 'browserVersion']) {
    if (expected[key] && manifest[key] !== expected[key]) {
      throw new Error(
        `Recording-browser ${key} mismatch: expected ${expected[key]}, got ${manifest[key]}.`,
      );
    }
  }
  return manifest;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

// Read the Mach-O header directly, including universal headers. This also works on
// non-Mac CI hosts and does not execute an unverified downloaded binary.
export async function machoArchitectures(filename) {
  const handle = await open(filename, 'r');
  try {
    const data = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead < 8) return [];
    const magic = data.readUInt32BE(0);
    const arch = (cpu) => ({ 16777228: 'arm64', 16777223: 'x64' })[cpu] ?? `cpu-${cpu}`;
    if ([0xcffaedfe, 0xcefaedfe].includes(magic)) return [arch(data.readUInt32LE(4))];
    if ([0xfeedfacf, 0xfeedface].includes(magic)) return [arch(data.readUInt32BE(4))];
    if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return [];
    const little = [0xbebafeca, 0xbfbafeca].includes(magic);
    const read = (offset) => (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset));
    const count = read(4);
    const stride = [0xcafebabf, 0xbfbafeca].includes(magic) ? 32 : 20;
    if (!count || count > 32 || 8 + count * stride > bytesRead)
      throw new Error('Malformed universal Mach-O header.');
    return Array.from({ length: count }, (_, index) => arch(read(8 + index * stride)));
  } finally {
    await handle.close();
  }
}

async function walk(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(root, await realpath(filename)))
          throw new Error('Recording-browser contains an escaping symlink.');
      } else if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
      else throw new Error('Recording-browser contains an unsupported filesystem entry.');
    }
  }
  await visit(root);
  return files;
}

function plistString(xml, key) {
  return xml.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]+)</string>`))?.[1];
}

export async function verifyRecordingBrowser(input, expected = {}) {
  let extracted;
  try {
    let root = path.resolve(input);
    if (root.endsWith('.zip')) {
      if (process.platform !== 'darwin')
        throw new Error('Release ZIP verification requires macOS ditto.');
      extracted = await mkdtemp(path.join(tmpdir(), 'testloom-browser-verify-'));
      execFileSync('/usr/bin/ditto', ['-x', '-k', root, extracted], {
        timeout: 180_000,
        stdio: 'pipe',
      });
      root = extracted;
    }
    if (!root.endsWith('.app')) {
      const apps = (await readdir(root, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
      );
      if (apps.length === 1) root = path.join(root, apps[0].name);
      else if (apps.length > 1) throw new Error('Specify the exact built app to verify.');
    }
    let appPath;
    if (root.endsWith('.app')) {
      appPath = root;
      root = path.join(root, 'Contents/Resources/recording-browser');
    }
    if ((await lstat(root)).isSymbolicLink())
      throw new Error('Recording-browser root must not be a symlink.');
    root = await realpath(root);
    const manifestPath = path.join(root, 'manifest.json');
    if (!(await lstat(manifestPath)).isFile())
      throw new Error('Recording-browser manifest must be a regular file.');
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), {
      ...(await pinnedBrowser()),
      ...expected,
    });
    const executable = path.join(root, manifest.executable);
    if (!inside(root, await realpath(executable)))
      throw new Error('Recording-browser executable escapes the bundle.');
    await access(executable, constants.X_OK);
    const architectures = await machoArchitectures(executable);
    if (architectures.length !== 1 || architectures[0] !== manifest.arch)
      throw new Error('Recording-browser executable architecture does not match its manifest.');
    if (process.platform === 'darwin') {
      const native = execFileSync('/usr/bin/lipo', ['-archs', executable], {
        encoding: 'utf8',
      }).trim();
      if (native !== (manifest.arch === 'x64' ? 'x86_64' : 'arm64'))
        throw new Error('lipo rejected the recording-browser architecture.');
    }
    const browserApp = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
    const info = await readFile(path.join(browserApp, 'Contents/Info.plist'), 'utf8');
    if (
      plistString(info, 'CFBundleShortVersionString') !== manifest.browserVersion ||
      plistString(info, 'CFBundleExecutable') !== path.basename(executable)
    ) {
      throw new Error('Recording-browser app version or executable does not match the manifest.');
    }
    const files = await walk(root);
    const relative = files.map((filename) =>
      path.relative(browserApp, filename).split(path.sep).join('/'),
    );
    const required = [
      /\/[^/]+\.framework\/Versions\/[^/]+\/[^/]+$/,
      /\/Resources\/icudtl\.dat$/,
      /\/Resources\/resources\.pak$/,
      new RegExp(
        `/Resources/v8_context_snapshot\\.${manifest.arch === 'x64' ? 'x86_64' : 'arm64'}\\.bin$`,
      ),
      /\/Resources\/.*\.lproj\/.*\.pak$/,
      /\/Helpers\/.*Helper \(Renderer\)\.app\/Contents\/MacOS\//,
      /\/Helpers\/.*Helper \(GPU\)\.app\/Contents\/MacOS\//,
      /\/Helpers\/chrome_crashpad_handler$/,
      /\/Libraries\/.*\.dylib$/,
      /^Contents\/Resources\//,
    ];
    if (required.some((pattern) => !relative.some((filename) => pattern.test(filename))))
      throw new Error('Recording-browser is missing full browser resources, helpers or libraries.');
    let binaries = 0;
    for (const filename of files) {
      const actual = await machoArchitectures(filename);
      if (!actual.length) continue;
      binaries++;
      if (!actual.includes(manifest.arch))
        throw new Error('Recording-browser contains an incompatible framework, helper or library.');
    }
    if (binaries < 5)
      throw new Error('Recording-browser is missing its native framework and helpers.');
    if (appPath) {
      const packages = path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules');
      const packagedPlaywright = JSON.parse(
        await readFile(path.join(packages, 'playwright/package.json'), 'utf8'),
      );
      const packagedCore = JSON.parse(
        await readFile(path.join(packages, 'playwright-core/package.json'), 'utf8'),
      );
      const packagedBrowsers = JSON.parse(
        await readFile(path.join(packages, 'playwright-core/browsers.json'), 'utf8'),
      );
      if (
        packagedPlaywright.version !== manifest.playwrightVersion ||
        packagedCore.version !== manifest.playwrightVersion ||
        packagedBrowsers.browsers.find((browser) => browser.name === 'chromium')?.browserVersion !==
          manifest.browserVersion
      ) {
        throw new Error('Packaged Playwright and recording-browser versions do not match.');
      }
      const outerBinaries = await readdir(path.join(appPath, 'Contents/MacOS'));
      if (
        outerBinaries.length !== 1 ||
        !(
          await machoArchitectures(path.join(appPath, 'Contents/MacOS', outerBinaries[0]))
        ).includes(manifest.arch)
      ) {
        throw new Error('Electron app and recording-browser architectures do not match.');
      }
    }
    return { ...manifest, binaries, files: files.length };
  } finally {
    if (extracted) await rm(extracted, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, ...args] = process.argv.slice(2);
  if (
    !input ||
    (args.length &&
      (args.length !== 2 || args[0] !== '--arch' || !['arm64', 'x64'].includes(args[1])))
  ) {
    console.error(
      'Usage: node scripts/verify-recording-browser.mjs <app.app|release.zip|extracted-directory|recording-browser> [--arch arm64|x64]',
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await verifyRecordingBrowser(input, { arch: args[1] }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
