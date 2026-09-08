// Opt-in Mac check: TESTLOOM_REMOTE_URL=https://your-app.example.com npx tsx tests/remote-url.integration.ts
// Opens a fresh recording browser and stops it without clicking or submitting on the website.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppState } from '../src/shared/types';

const input = process.env.TESTLOOM_REMOTE_URL;
assert.ok(input, 'Set TESTLOOM_REMOTE_URL to an HTTP/HTTPS page you are authorized to open.');
const url = new URL(input);
assert.ok(
  ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
);
const root = await mkdtemp(path.join(tmpdir(), 'testloom-remote-desktop-'));
const project = path.join(root, 'source');
await mkdir(project);
const manifest = '{"name":"remote-test-project","devDependencies":{"@playwright/test":"1.63.0"}}\n';
await writeFile(path.join(project, 'package.json'), manifest);
const executable = process.env.TESTLOOM_EXECUTABLE;
const desktop = await electron.launch({
  ...(executable ? { executablePath: executable } : {}),
  args: executable ? [] : [path.resolve('.')],
  env: { ...process.env, TESTLOOM_DATA_DIR: path.join(root, 'app') },
});
const errors: string[] = [];
try {
  const window = await desktop.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  await window.locator('#open-project:not([disabled])').waitFor();
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as typeof dialog.showOpenDialog;
  }, project);
  await window.locator('#open-project').click();
  await window.locator('#record-button:not([disabled])').waitFor();
  await window.locator('#record-button').click();
  await window.locator('#record-name').fill('Remote HTTPS startup validation');
  await window.locator('#start-url').fill(url.toString());
  await window.locator('#start-recording').click();
  if (process.env.TESTLOOM_EXPECT_MISSING_BROWSER === '1') {
    await window.locator('#record-error:visible').waitFor({ timeout: 60_000 });
    const message = await window.locator('#record-error').textContent();
    assert.match(message ?? '', /No recording browser was found/);
    assert.match(message ?? '', /npx playwright@1\.63\.0 install chromium/);
    assert.doesNotMatch(message ?? '', /Error invoking remote method|\/Users\//);
    const failed: AppState = await window.evaluate(() => (window as any).journey.getState());
    assert.equal(failed.phase, 'idle');
    assert.equal(failed.cases.length, 0);
    assert.equal(await readFile(path.join(project, 'package.json'), 'utf8'), manifest);
    assert.deepEqual(errors, []);
    await mkdir('work', { recursive: true });
    await window.screenshot({ path: 'work/missing-browser-dialog.png' });
    const report = {
      status: 'passed',
      packaged: !!executable,
      missingBrowserExplained: true,
      message,
      sourceUnchanged: true,
      rendererErrors: errors,
    };
    await writeFile('work/missing-browser-validation.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else {
    await window.locator('#record-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
    const current: AppState = await window.evaluate(() => (window as any).journey.getState());
    assert.equal(current.phase, 'recording');
    assert.ok(current.scenario?.events.some((e) => e.action === 'navigate'));
    await window.locator('#stop-recording:not([disabled])').click();
    const deadline = Date.now() + 15_000;
    let saved: AppState;
    do {
      saved = await window.evaluate(() => (window as any).journey.getState());
      if (saved.phase === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(saved.phase, 'idle');
    await mkdir('work', { recursive: true });
    if (saved.cases.length !== 1)
      await writeFile('work/remote-recording-failure.json', JSON.stringify(saved, null, 2));
    assert.equal(
      saved.cases.length,
      1,
      saved.error || (await window.locator('#error-message').textContent()) || 'No saved case',
    );
    assert.equal(saved.cases[0].scenario.startUrl, url.toString());
    assert.ok(saved.cases[0].scenario.events.every((e) => e.action === 'navigate'));
    assert.equal(await readFile(path.join(project, 'package.json'), 'utf8'), manifest);
    assert.deepEqual(errors, []);
    await mkdir('work', { recursive: true });
    const report = {
      status: 'passed',
      packaged: !!executable,
      startUrl: url.toString(),
      events: saved.cases[0].scenario.events.map((e) => ({ action: e.action, url: e.url })),
      warnings: saved.cases[0].scenario.warnings,
      sourceUnchanged: true,
      websiteInteractions: false,
      rendererErrors: errors,
    };
    await writeFile('work/remote-startup-validation.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  await desktop.close();
  await rm(root, { recursive: true, force: true });
}
