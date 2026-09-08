import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { release } from 'node:os';
import playwrightPackage from 'playwright/package.json';

/** A release owns its exact browser; never guess a path in somebody else's cache. */
export async function bundledBrowserExecutable(root: string): Promise<string> {
  let manifest: Record<string, unknown>;
  try {
    const text = await readFile(path.join(root, 'manifest.json'), 'utf8');
    if (text.length > 4096) throw new Error();
    manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
  } catch {
    throw new Error('TESTLOOM_BUNDLE_INVALID');
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.playwrightVersion !== playwrightPackage.version ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    typeof manifest.executable !== 'string' ||
    !manifest.executable ||
    path.isAbsolute(manifest.executable) ||
    manifest.executable.split(/[\\/]/).some((part) => part === '..')
  )
    throw new Error('TESTLOOM_BUNDLE_INVALID');
  const folder = await realpath(root);
  const executable = await realpath(path.join(folder, manifest.executable)).catch(() => '');
  if (!executable.startsWith(folder + path.sep)) throw new Error('TESTLOOM_BUNDLE_INVALID');
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error('TESTLOOM_BUNDLE_INVALID');
  }
  return executable;
}

export function checkRecordingPlatform(platform = process.platform, osRelease = release()): void {
  // Darwin 23 is macOS 14, the minimum supported by the pinned browser.
  if (platform === 'darwin' && Number(osRelease.split('.')[0]) < 23)
    throw new Error('TESTLOOM_MACOS_UNSUPPORTED');
}
