import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import verifyMacRelease, { verifyMacSignature } from '../scripts/verify-mac-signature.mjs';

test(
  'Mac release gate accepts a sealed ZIP and rejects changed resources',
  {
    skip: process.platform !== 'darwin',
  },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'testloom-signature-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const app = path.join(root, 'Fixture.app');
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
    writeFileSync(
      path.join(app, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>dev.testloom.signature-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    const resource = path.join(app, 'Contents/Resources/data.txt');
    writeFileSync(resource, 'original release');
    execFileSync(
      '/usr/bin/clang',
      ['-x', 'c', '-', '-o', path.join(app, 'Contents/MacOS/Fixture')],
      {
        input: 'int main(void) { return 0; }',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // A linker signature is not a complete app-bundle signature (the v0.2.0 defect).
    assert.throws(() => verifyMacSignature(app));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
    verifyMacSignature(app);
    const packager = { appInfo: { productFilename: 'Fixture' } };
    const zip = path.join(root, 'good.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    verifyMacRelease({ file: zip, packager });
    writeFileSync(resource, 'modified after signing');
    assert.throws(() => verifyMacSignature(app));
    const badZip = path.join(root, 'bad.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, badZip]);
    assert.throws(() => verifyMacRelease({ file: badZip, packager }));
  },
);
