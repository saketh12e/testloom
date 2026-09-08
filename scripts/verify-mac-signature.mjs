import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRecordingBrowser } from './verify-recording-browser.mjs';

// Integrity verification is separate from Developer ID trust and notarization.
export function verifyMacSignature(appPath) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'pipe',
    timeout: 120_000,
  });
}

export default async function verifyMacRelease(context) {
  if (process.platform !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  if (context.file) {
    if (!context.file.endsWith('.zip')) return;
    const extracted = mkdtempSync(path.join(tmpdir(), 'testloom-release-check-'));
    try {
      execFileSync('/usr/bin/ditto', ['-x', '-k', context.file, extracted], {
        stdio: 'pipe',
        timeout: 120_000,
      });
      verifyMacSignature(path.join(extracted, appName));
      await verifyRecordingBrowser(path.join(extracted, appName));
      console.log('Verified Mac signature after extracting the release ZIP.');
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  } else if (context.electronPlatformName === 'darwin') {
    verifyMacSignature(path.join(context.appOutDir, appName));
    await verifyRecordingBrowser(path.join(context.appOutDir, appName));
    console.log('Verified Mac app signature before packaging.');
  }
}
