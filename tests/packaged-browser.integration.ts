// Release gate: exercise the ZIP a friend receives with no Playwright cache or Node on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import type { AppState } from '../src/shared/types';

assert.equal(process.platform, 'darwin', 'Run the packaged Mac gate on macOS.');
const releaseDir = path.resolve(process.env.TESTLOOM_RELEASE_DIR || 'release');
const archive =
  process.env.TESTLOOM_RELEASE_ZIP ||
  (await readdir(releaseDir))
    .filter((name) => name.endsWith(`-${process.arch}-mac.zip`))
    .sort()
    .at(-1);
assert.ok(archive, 'Build a release ZIP or set TESTLOOM_RELEASE_ZIP.');
const zip = process.env.TESTLOOM_RELEASE_ZIP
  ? path.resolve(archive)
  : path.join(releaseDir, archive);
const root = await mkdtemp(path.join(tmpdir(), 'Testloom fresh Mac '));
let requests = 0;
const server = createServer((request, response) => {
  if (request.url === '/journey') requests++;
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<title>Recording gate</title><h1>Healthy recording browser</h1>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/journey`;
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, root], { timeout: 120_000 });
  const app = path.join(root, 'Testloom.app');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 120_000 });
  const project = path.join(root, 'source');
  const emptyCache = path.join(root, 'empty browser cache');
  await mkdir(project);
  await mkdir(emptyCache);
  const original =
    '{"name":"packaged-recording-fixture","devDependencies":{"@playwright/test":"1.63.0"}}\n';
  await writeFile(path.join(project, 'package.json'), original);
  const executablePath = path.join(app, 'Contents/MacOS/Testloom');
  const env = {
    ...process.env,
    TESTLOOM_DATA_DIR: path.join(root, 'data'),
    PLAYWRIGHT_BROWSERS_PATH: emptyCache,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const launch = () => electron.launch({ executablePath, args: [], env });
  desktop = await launch();
  const window = await desktop.firstWindow();
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(error.message));
  await window.locator('#open-project:not([disabled])').waitFor();
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as typeof dialog.showOpenDialog;
  }, project);
  await window.locator('#open-project').click();
  await window.locator('#record-button:not([disabled])').click();
  await window.locator('#record-name').fill('Fresh Mac recording');
  await window.locator('#start-url').fill(url);
  await window.locator('#start-recording').click();
  await window.locator('#record-dialog').waitFor({ state: 'hidden', timeout: 60_000 });
  const getState = (): Promise<AppState> =>
    window.evaluate(() => (window as any).journey.getState());
  let state = await getState();
  assert.equal(state.phase, 'recording');
  assert.equal(state.browserStartup?.outcome, 'ready');
  assert.deepEqual(
    state.browserStartup?.attempts.map((attempt) => [attempt.browser, attempt.outcome]),
    [['Testloom Chromium', 'ready']],
  );
  assert.equal(requests, 1, 'The target must not be replayed by startup recovery.');
  await window.locator('#stop-recording:not([disabled])').click();
  const deadline = Date.now() + 15_000;
  do {
    state = await getState();
    if (state.phase === 'idle') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(state.phase, 'idle');
  assert.equal(state.cases.length, 1);
  assert.ok(state.cases[0].scenario.events.some((event) => event.action === 'navigate'));
  assert.equal(await readFile(path.join(project, 'package.json'), 'utf8'), original);
  assert.deepEqual(
    await readdir(emptyCache),
    [],
    'Packaged recording must not install into or use the global cache.',
  );
  const output = path.join(root, 'exported-startup.json');
  await desktop.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog;
  }, output);
  await window.evaluate(() => (window as any).journey.exportBrowserStartupReport());
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(report, state.browserStartup);
  assert.ok(report);
  assert.doesNotMatch(
    JSON.stringify(report),
    /127\.0\.0\.1|journey|\/Users\/|\/var\/|https?:|source|password/,
  );
  assert.deepEqual(errors, []);
  await desktop.close();
  desktop = undefined;
  desktop = await launch();
  const reopened = await desktop.firstWindow();
  await reopened.locator('#record-button:not([disabled])').waitFor();
  const restored: AppState = await reopened.evaluate(() => (window as any).journey.getState());
  assert.equal(restored.browserStartup?.id, report.id, 'Report survives app restart.');
  assert.equal(restored.browserStartupProgress, undefined);
  // A website failure must preserve browser diagnostics and never retry the site through another browser.
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await reopened.locator('#record-button').click();
  await reopened.locator('#record-name').fill('Unavailable website');
  await reopened.locator('#start-url').fill(url);
  await reopened.locator('#start-recording').click();
  await reopened.locator('#record-error:visible').waitFor({ timeout: 60_000 });
  assert.match(await reopened.locator('#record-error').innerText(), /could not reach the website/);
  const failed: AppState = await reopened.evaluate(() => (window as any).journey.getState());
  assert.equal(failed.phase, 'idle');
  assert.equal(failed.cases.length, 1);
  assert.equal(failed.browserStartup?.outcome, 'failed');
  assert.equal(failed.browserStartup?.stage, 'navigation');
  assert.deepEqual(
    failed.browserStartup?.attempts.map((attempt) => attempt.browser),
    ['Testloom Chromium'],
  );
  await desktop.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog;
  }, output);
  await reopened.locator('#export-browser-startup:visible').click();
  const exportDeadline = Date.now() + 5000;
  let exportedFailure;
  do {
    exportedFailure = JSON.parse(await readFile(output, 'utf8'));
    if (exportedFailure.id === failed.browserStartup?.id) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < exportDeadline);
  assert.equal(exportedFailure.id, failed.browserStartup?.id);
  // Cancel preparation, including the interval when chromium.launch has not returned yet.
  await reopened.locator('#start-recording').click();
  await reopened.locator('#cancel-record:not([disabled])').click();
  await reopened.locator('#record-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
  const cancelled: AppState = await reopened.evaluate(() => (window as any).journey.getState());
  assert.equal(cancelled.phase, 'idle');
  assert.equal(cancelled.cases.length, 1);
  assert.equal(cancelled.browserStartup?.outcome, 'cancelled');
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        appVersion: report.appVersion,
        arch: report.arch,
        packagedBrowser: report.attempts[0].browser,
        emptyCache: true,
        noNodeOnPath: true,
        sourceUnchanged: true,
        targetNavigations: requests,
        reportExportAndRestore: true,
        navigationFailureReported: true,
        preparationCancelled: true,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await desktop?.close();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(root, { recursive: true, force: true });
}
